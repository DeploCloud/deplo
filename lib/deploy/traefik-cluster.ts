import { Document, isMap, isSeq } from "yaml";

import {
  ACME_PATH,
  ACME_PRIORITY,
  ANSWER_ENTRYPOINT,
  ANSWER_PORT,
  ANSWER_TRANSPORT,
} from "./answer";
import {
  CHALLENGE_PORT,
  CHALLENGE_SECRET_FILE,
  DNS_CHALLENGE_RESOLVER,
} from "./dns-challenge";
import {
  ANSWER_CONFIG,
  DEPLO_DYNAMIC_DIR,
  addTo,
  certResolver,
  dropFileProvider,
  dropOurConfig,
  dump,
  entryName,
  fileProviderDir,
  listOf,
  mountDeploConfig,
  parseCompose,
  scalar,
  setList,
  traefikService,
} from "./traefik-compose";

// What a cluster changes in a server's proxy: https://deplo.build/docs/operations/clusters/addresses

const ANSWER_FILE = "deplo-answer.yml";

/** Beside the stack's compose file on the server; its agent rewrites it in place (ADR-0048). */
export const ANSWER_ROUTES_FILE = "answers.yml";

const ANSWER_ROUTES_TARGET = "deplo-answers.yml";

const answerFlags = (web: string) => [
  `--entrypoints.${web}.allowacmebypass=true`,
  `--entrypoints.${ANSWER_ENTRYPOINT}.address=127.0.0.1:${ANSWER_PORT}`,
  `--entrypoints.${ANSWER_ENTRYPOINT}.proxyprotocol.trustedips=127.0.0.1/32`,
];

// The entrypoint the certificate checks arrive on: the installer's `web`, unless the proxy names its own.
function challengeEntrypoint(command: string[]): string {
  for (const flag of command) {
    const m = flag.match(
      /^--certificatesresolvers\.[^.]+\.acme\.httpchallenge\.entrypoint=(.+)$/,
    );
    if (m) return m[1];
  }
  return "web";
}

function isAnswerMount(entry: unknown): boolean {
  const spec = isMap(entry) ? scalar(entry.get("target", true)) : scalar(entry);
  return spec.includes(ANSWER_ROUTES_TARGET);
}

/** Whether this server's proxy passes cluster domains on (ADR-0048). */
export function hasAnswerSupport(currentYaml: string): boolean {
  try {
    const doc = parseCompose(currentYaml);
    return (
      doc.getIn(["configs", ANSWER_CONFIG, "content"]) !== undefined &&
      listOf(traefikService(doc).get("command", true)).some((c) =>
        c.startsWith(`--entrypoints.${ANSWER_ENTRYPOINT}.address=`),
      )
    );
  } catch {
    return false;
  }
}

/**
 * Puts in or takes out what a server's proxy needs to pass a cluster domain on (ADR-0048): the internal entrypoint
 * on its own loopback, the check bypass on `web` with Deplo's own challenge router above every other router, the
 * PROXY transport, and the routes file its agent writes. Taking it out leaves the stack as it was before.
 */
export function withAnswerSupport(currentYaml: string, on: boolean): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  const command = listOf(service.get("command", true));
  const web = challengeEntrypoint(command);
  const ours = new Set(answerFlags(web).map(entryName));
  setList(doc, service, "command", [
    ...command.filter((c) => !ours.has(entryName(c))),
    ...(on ? answerFlags(web) : []),
  ]);
  const volumes = service.get("volumes", true);
  if (isSeq(volumes)) {
    volumes.items = volumes.items.filter((v) => !isAnswerMount(v));
    if (volumes.items.length === 0) service.delete("volumes");
  }
  dropOurConfig(doc, service, ANSWER_CONFIG);
  if (!on) {
    dropFileProvider(doc, service, ANSWER_CONFIG);
    return dump(doc);
  }
  const file = new Document({
    http: {
      routers: {
        "deplo-acme": {
          rule: `PathPrefix(\`${ACME_PATH}\`)`,
          entryPoints: [web, ANSWER_ENTRYPOINT],
          service: "acme-http@internal",
          priority: ACME_PRIORITY,
        },
      },
    },
    tcp: {
      serversTransports: {
        [ANSWER_TRANSPORT]: { proxyProtocol: { version: 2 } },
      },
    },
  });
  mountDeploConfig(
    doc,
    service,
    ANSWER_CONFIG,
    ANSWER_FILE,
    "the cluster's domains",
    file.toString({ lineWidth: 0 }),
  );
  const dir =
    fileProviderDir(
      listOf(service.get("command", true)),
      "the cluster's domains",
    ) ?? DEPLO_DYNAMIC_DIR;
  addTo(
    doc,
    service,
    "volumes",
    `./${ANSWER_ROUTES_FILE}:${dir}/${ANSWER_ROUTES_TARGET}:ro`,
  );
  return dump(doc);
}

const dnsResolverFlag = `--certificatesresolvers.${DNS_CHALLENGE_RESOLVER}.`;
const CHALLENGE_SECRET_TARGET = `/deplo-${CHALLENGE_SECRET_FILE}`;
const challengeEnv = [
  `HTTPREQ_ENDPOINT=http://127.0.0.1:${CHALLENGE_PORT}`,
  "HTTPREQ_USERNAME=deplo",
  `HTTPREQ_PASSWORD_FILE=${CHALLENGE_SECRET_TARGET}`,
  // The agent maps a name outside the zone to its CNAME's target itself, so the proxy looks nothing up.
  "LEGO_DISABLE_CNAME_SUPPORT=true",
];
const challengeEnvNames = new Set(challengeEnv.map(entryName));

const isChallengeMount = (entry: unknown) =>
  (isMap(entry) ? scalar(entry.get("target", true)) : scalar(entry)).includes(
    CHALLENGE_SECRET_TARGET,
  );

/** Whether this server's proxy can get a certificate over DNS through its agent (ADR-0049). */
export function hasDnsChallenge(currentYaml: string): boolean {
  try {
    return listOf(
      traefikService(parseCompose(currentYaml)).get("command", true),
    ).includes(`${dnsResolverFlag}acme.dnschallenge.provider=httpreq`);
  } catch {
    return false;
  }
}

/**
 * Puts in or takes out the resolver that gets a certificate over DNS (ADR-0049 phase 3): a copy of the proxy's own
 * account settings, whose checks its server agent sets on the proxy's loopback, asking a secret only the proxy reads.
 * No DNS provider's token is involved. Taking it out leaves the stack as it was before.
 */
export function withDnsChallenge(currentYaml: string, on: boolean): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  const command = listOf(service.get("command", true)).filter(
    (c) => !c.startsWith(dnsResolverFlag),
  );
  const own = `--certificatesresolvers.${certResolver(command)}.acme.`;
  const copied = on
    ? command
        .filter(
          (c) =>
            c.startsWith(own) &&
            !/^(http|tls|dns)challenge/.test(c.slice(own.length)),
        )
        .map((c) => `${dnsResolverFlag}acme.${c.slice(own.length)}`)
    : [];
  setList(doc, service, "command", [
    ...command,
    ...copied,
    ...(on
      ? [
          `${dnsResolverFlag}acme.dnschallenge.provider=httpreq`,
          `${dnsResolverFlag}acme.dnschallenge.propagation.disablechecks=true`,
        ]
      : []),
  ]);
  const envNode = service.get("environment", true);
  if (isMap(envNode)) {
    // Keyed form: a key with no value passes the host's through, which a list would turn into an empty one.
    for (const name of challengeEnvNames) envNode.delete(name);
    if (on)
      for (const e of challengeEnv)
        envNode.set(entryName(e), e.slice(entryName(e).length + 1));
  } else {
    const env = listOf(envNode).filter(
      (e) => !challengeEnvNames.has(entryName(e)),
    );
    setList(doc, service, "environment", [...env, ...(on ? challengeEnv : [])]);
  }
  const volumes = service.get("volumes", true);
  if (isSeq(volumes)) {
    volumes.items = volumes.items.filter((v) => !isChallengeMount(v));
    if (volumes.items.length === 0) service.delete("volumes");
  }
  if (on)
    addTo(
      doc,
      service,
      "volumes",
      `./${CHALLENGE_SECRET_FILE}:${CHALLENGE_SECRET_TARGET}:ro`,
    );
  return dump(doc);
}

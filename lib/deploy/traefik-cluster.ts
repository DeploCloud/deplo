import { Document, isMap, isSeq } from "yaml";

import {
  ACME_PATH,
  ACME_PRIORITY,
  ANSWER_ENTRYPOINT,
  ANSWER_PORT,
  ANSWER_TRANSPORT,
} from "./answer";
import {
  ANSWER_CONFIG,
  DEPLO_DYNAMIC_DIR,
  addTo,
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

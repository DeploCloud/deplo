import "server-only";

import yaml from "../../yaml";

import {
  composeTruthy,
  interpolates,
  isInterpolated,
} from "../compose-lint/document";
import {
  interpolatedHostnameMessage,
  isDeploNetwork,
  reservedNameMessage,
  serviceClaimedNames,
  serviceReservedClaim,
  sharedNetworkKeys,
} from "../compose-lint/networks";
import { INFRA_NETWORK, isPreviewNetwork } from "../network";
import type { App, ComposeDoc, ComposeStackInput } from "./types";

// declaredNetworkKeys is the networks a service names, or null when it names none
// (compose then puts it on `default`, which each caller decides about itself).
export function declaredNetworkKeys(svc: unknown): string[] | null {
  const nets = (svc as App | undefined)?.networks;
  if (Array.isArray(nets)) return nets.map(String);
  if (nets && typeof nets === "object") return Object.keys(nets);
  return null;
}

// internalNetworkKeys is the top-level networks the author marked `internal: true` -
// no route off the host, the one deliberate isolation the render leaves alone.
export function internalNetworkKeys(doc: ComposeDoc): Set<string> {
  return new Set(
    Object.entries(
      doc.networks &&
        typeof doc.networks === "object" &&
        !Array.isArray(doc.networks)
        ? (doc.networks as Record<string, unknown>)
        : {},
    )
      .filter(
        ([, v]) =>
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          composeTruthy((v as Record<string, unknown>).internal),
      )
      .map(([k]) => k),
  );
}

// assertNetworkModeIsNotANetwork refuses a `network_mode:` that names a network:
// any non-keyword value is a docker NETWORK NAME, joined with DNS while `networks:`
// stays empty, and a `${VAR}` from the env-file is invisible to the authored text.
export function assertNetworkModeIsNotANetwork(
  service: string,
  mode: unknown,
): void {
  if (typeof mode !== "string") return;
  const value = mode.trim();
  // `container:deplo-traefik` lands this container inside the proxy, which sits on
  // every tenant network of the host - same reach as naming a network. `service:<x>`
  // is compose's own same-file form and is left to the host grant.
  if (/^container:/i.test(value)) {
    throw new Error(
      `\`network_mode: ${value}\` on service \`${service}\` joins another ` +
        `container's network namespace, which reaches every network that container ` +
        `is on. Use your own Environment's network instead.`,
    );
  }
  // `$$` is compose's ESCAPE for a literal dollar, so it interpolates nothing. Every
  // other `$` does - `$NET` without braces just as much as `${NET}`.
  if (interpolates(value)) {
    throw new Error(
      `\`network_mode\` on service \`${service}\` is filled in from a variable. ` +
        `Deplo cannot tell which network that names, so it is refused - write the ` +
        `value in the compose file.`,
    );
  }
  if (isDeploNetwork(value)) {
    throw new Error(
      `\`network_mode: ${value}\` on service \`${service}\` names a network Deplo ` +
        `manages. Join your own Environment's network instead - remove ` +
        `\`network_mode\` and the service is on it already.`,
    );
  }
}

// assertNoInterpolatedNetworkName refuses a top-level network whose `name:` is filled
// in at `compose up`: `sharedNetworkKeys` resolves by NAME, so an interpolated one is
// invisible to the collapse, to the clash guard and to the cross-network warning.
export function assertNoInterpolatedNetworkName(doc: ComposeDoc): void {
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const ext =
      n.external && typeof n.external === "object" && !Array.isArray(n.external)
        ? (n.external as Record<string, unknown>).name
        : undefined;
    for (const candidate of [n.name, ext]) {
      if (typeof candidate !== "string") continue;
      if (!interpolates(candidate)) continue;
      throw new Error(
        `The network \`${key}\` takes its name from a variable, so Deplo cannot ` +
          `tell which network it is before it runs. Write the name in the compose ` +
          `file, or drop \`name:\` and let Deplo place the stack.`,
      );
    }
  }
}

// assertHostnameIsWritten refuses an interpolated `hostname:` - a second DNS name on
// the network, so one filled in at run time can land on `deplo` or on a neighbour's.
export function assertHostnameIsWritten(
  service: string,
  hostname: unknown,
): void {
  if (isInterpolated(hostname))
    throw new Error(interpolatedHostnameMessage(service));
}

// WireApp joins one service to the stack's network, answering false when it cannot.
export type WireApp = (service: string) => boolean;

// createAppWiring joins a service to the Deplo network on top of its own networks, so
// Traefik can reach it and inter-service DNS keeps working - once per service, so one
// routed on two hosts/ports is wired only once.
export function createAppWiring(services: Record<string, App>): WireApp {
  const wired = new Set<string>();
  return (service: string): boolean => {
    const target = services[service] as App | undefined;
    if (!target) return false;
    if (target.network_mode != null) return false;
    if (wired.has(service)) return true;
    const nets = target.networks;
    if (nets && typeof nets === "object" && !Array.isArray(nets)) {
      // Long form: ADD the key, never rebuild the block as a list. Flattening it
      // dropped the author's `aliases`/`ipv4_address` on their OWN private networks.
      const map = nets as Record<string, unknown>;
      if (!(INFRA_NETWORK in map)) map[INFRA_NETWORK] = null;
    } else {
      const existing = declaredNetworkKeys(target) ?? [];
      // A service that declared nothing goes on the Environment's network ALONE, not
      // `default` as well: that is one more network per stack against the host's
      // address-pool ceiling, for no reach the stack does not already have.
      target.networks = Array.from(new Set([...existing, INFRA_NETWORK]));
    }
    wired.add(service);
    return true;
  };
}

// joinEveryService puts EVERY service on the stack's network, not only the routed ones:
// a worker with no domain still needs its Environment's database.
export function joinEveryService(opts: {
  doc: ComposeDoc;
  services: Record<string, App>;
  input: ComposeStackInput;
  wireApp: WireApp;
}): void {
  const { doc, services, input, wireApp } = opts;
  // A PREVIEW is sealed alone, so it reads no neighbour names.
  const taken = new Set(
    isPreviewNetwork(input.network)
      ? []
      : (input.takenNames ?? []).map((n) => n.toLowerCase()),
  );
  // Why this service must stay off the shared network, or "".
  const keepOff = (name: string): string => {
    const claim = serviceReservedClaim(name, services[name]);
    if (claim)
      return `it answers to \`${claim}\`, a name Deplo's own infrastructure uses`;
    const stolen = serviceClaimedNames(name, services[name]).find((n) =>
      taken.has(n.toLowerCase()),
    );
    return stolen
      ? `\`${stolen}\` is already answered by another stack in this environment`
      : "";
  };
  const reserved = Object.keys(services).filter((name) => keepOff(name) !== "");
  // Naming your own networks is NOT isolation: organising services into
  // frontend/backend is what every non-trivial compose file does, and reading that as
  // "leave me alone" cut most stacks off from their own database.
  const internalNetworks = internalNetworkKeys(doc);
  // True when every network this service joins is one the author sealed off.
  const onlyInternal = (name: string): boolean => {
    const joined = declaredNetworkKeys(services[name]) ?? ["default"];
    return joined.length > 0 && joined.every((k) => internalNetworks.has(k));
  };
  // Read before the `default` below is added, or the test would see Deplo's own edit.
  const sealedOff = new Map(
    Object.keys(services).map((name) => [name, onlyInternal(name)]),
  );
  for (const name of Object.keys(services)) {
    const svc = services[name] as App | undefined;
    // NOT into a sealed service: `internal: true` is a network with no route off the
    // host, and `default` is a NAT bridge - injecting it to reunite the stack handed a
    // deliberately sealed worker its internet egress back.
    if (
      reserved.length > 0 &&
      svc &&
      svc.network_mode == null &&
      !sealedOff.get(name)
    ) {
      const nets = svc.networks;
      if (Array.isArray(nets) || nets == null)
        svc.networks = Array.from(
          new Set([
            ...(Array.isArray(nets) ? nets.map(String) : []),
            "default",
          ]),
        );
      else if (typeof nets === "object" && !("default" in nets))
        (nets as Record<string, unknown>).default = null;
    }
    const why = keepOff(name);
    if (why) {
      input.onWarn?.(
        `Service \`${name}\` is kept off this environment's network because ${why}. ` +
          `The rest of your stack still reaches it by name; nothing outside does. ` +
          `Rename it to put it on the network.`,
      );
      continue;
    }
    // Sealed off on purpose ⇒ left alone, since adding the Environment's network hands
    // back the egress the author removed. A ROUTED service is wired regardless, or its
    // domain would answer nothing.
    if (sealedOff.get(name)) continue;
    wireApp(name);
  }
}

// collapseOntoStackNetwork is THE choke point for this stack's own network: every key
// that RESOLVES to a network Deplo owns collapses onto `deplo`, so exactly one entry
// names this network and nothing joins it twice (ADR-0028).
export function collapseOntoStackNetwork(
  doc: ComposeDoc,
  services: Record<string, App>,
  network: string,
): void {
  assertNoInterpolatedNetworkName(doc);
  const sharedKeys = sharedNetworkKeys(doc as { networks?: unknown });
  // A service that declares no `networks:` joins `default`, so a `default` aimed at a
  // network Deplo owns put the whole stack there with no key of its own to notice.
  const defaultIsShared = sharedKeys.has("default");
  for (const [name, raw] of Object.entries(services)) {
    const svc = raw as App | undefined;
    if (!svc || typeof svc !== "object") continue;
    const nets = svc.networks;
    const declared = declaredNetworkKeys(svc);
    const joined = (declared ?? (defaultIsShared ? ["default"] : [])).filter(
      (k) => sharedKeys.has(k),
    );
    if (joined.length === 0) continue;
    const claim = serviceReservedClaim(name, svc);
    if (claim) throw new Error(reservedNameMessage(claim));
    if (declared === null) {
      svc.networks = [INFRA_NETWORK];
    } else if (Array.isArray(nets)) {
      svc.networks = [
        ...new Set(
          nets.map(String).map((k) => (sharedKeys.has(k) ? INFRA_NETWORK : k)),
        ),
      ];
    } else {
      // Long form: the author's own networks keep their options; every shared key
      // becomes one option-less `deplo`. The aliases were never theirs to hand out.
      const map = nets as Record<string, unknown>;
      for (const key of joined) delete map[key];
      map[INFRA_NETWORK] = null;
    }
  }

  // ONE top-level key: `deplo` is stable, `name:` points it at the Environment's own.
  // Every other key resolving to a network Deplo owns is dropped - two keys on one
  // network attaches it twice. A non-map `networks:` is dropped: `yaml.dump` loses a
  // key written onto an array.
  const authored = doc.networks;
  const networks = (
    authored && typeof authored === "object" && !Array.isArray(authored)
      ? authored
      : {}
  ) as Record<string, unknown>;
  for (const key of sharedKeys) if (key !== INFRA_NETWORK) delete networks[key];
  networks[INFRA_NETWORK] = { name: network, external: true };
  doc.networks = networks;
}

// stackNamesOnNetwork is the DNS names a RENDERED stack registers on the stack's own
// network: only the services actually joined to it, since one on a private network of
// its own is nobody's neighbour.
export function stackNamesOnNetwork(renderedYaml: string): string[] {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(renderedYaml) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(doc.services ?? {})) {
    const joined = declaredNetworkKeys(raw) ?? [];
    if (!joined.includes(INFRA_NETWORK)) continue;
    for (const claimed of serviceClaimedNames(name, raw))
      out.add(claimed.toLowerCase());
  }
  return [...out];
}

// retargetStackNetwork points a rendered stack's network entries at `network`, whatever
// they named before: a restore ships the stack file READ OFF THE HOST, which can name
// the network the app had before it moved, or one the cleanup has since reclaimed.
export function retargetStackNetwork(
  renderedYaml: string,
  network: string,
): string {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(renderedYaml) as ComposeDoc) ?? {};
  } catch {
    return renderedYaml;
  }
  const nets = doc.networks;
  if (!nets || typeof nets !== "object" || Array.isArray(nets))
    return renderedYaml;
  let touched = false;
  for (const [key, raw] of Object.entries(nets as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const named = typeof entry.name === "string" ? entry.name.trim() : "";
    if (key !== INFRA_NETWORK && !(named && isDeploNetwork(named))) continue;
    if (named === network) continue;
    (nets as Record<string, unknown>)[key] = {
      name: network,
      external: true,
    };
    touched = true;
  }
  if (!touched) return renderedYaml;
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

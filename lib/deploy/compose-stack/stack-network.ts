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

export function declaredNetworkKeys(svc: unknown): string[] | null {
  const nets = (svc as App | undefined)?.networks;
  if (Array.isArray(nets)) return nets.map(String);
  if (nets && typeof nets === "object") return Object.keys(nets);
  return null;
}

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

export function assertNetworkModeIsNotANetwork(
  service: string,
  mode: unknown,
): void {
  if (typeof mode !== "string") return;
  const value = mode.trim();
  if (/^container:/i.test(value)) {
    throw new Error(
      `\`network_mode: ${value}\` on service \`${service}\` joins another ` +
        `container's network namespace, which reaches every network that container ` +
        `is on. Use your own Environment's network instead.`,
    );
  }
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

export function assertHostnameIsWritten(
  service: string,
  hostname: unknown,
): void {
  if (isInterpolated(hostname))
    throw new Error(interpolatedHostnameMessage(service));
}

export type WireApp = (service: string) => boolean;

export function createAppWiring(services: Record<string, App>): WireApp {
  const wired = new Set<string>();
  return (service: string): boolean => {
    const target = services[service] as App | undefined;
    if (!target) return false;
    if (target.network_mode != null) return false;
    if (wired.has(service)) return true;
    const nets = target.networks;
    if (nets && typeof nets === "object" && !Array.isArray(nets)) {
      const map = nets as Record<string, unknown>;
      if (!(INFRA_NETWORK in map)) map[INFRA_NETWORK] = null;
    } else {
      const existing = declaredNetworkKeys(target) ?? [];
      target.networks = Array.from(new Set([...existing, INFRA_NETWORK]));
    }
    wired.add(service);
    return true;
  };
}

export function joinEveryService(opts: {
  doc: ComposeDoc;
  services: Record<string, App>;
  input: ComposeStackInput;
  wireApp: WireApp;
}): void {
  const { doc, services, input, wireApp } = opts;
  const taken = new Set(
    isPreviewNetwork(input.network)
      ? []
      : (input.takenNames ?? []).map((n) => n.toLowerCase()),
  );
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
  const internalNetworks = internalNetworkKeys(doc);
  const onlyInternal = (name: string): boolean => {
    const joined = declaredNetworkKeys(services[name]) ?? ["default"];
    return joined.length > 0 && joined.every((k) => internalNetworks.has(k));
  };
  const sealedOff = new Map(
    Object.keys(services).map((name) => [name, onlyInternal(name)]),
  );
  for (const name of Object.keys(services)) {
    const svc = services[name] as App | undefined;
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
    if (sealedOff.get(name)) continue;
    wireApp(name);
  }
}

export function collapseOntoStackNetwork(
  doc: ComposeDoc,
  services: Record<string, App>,
  network: string,
): void {
  assertNoInterpolatedNetworkName(doc);
  const sharedKeys = sharedNetworkKeys(doc as { networks?: unknown });
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
      const map = nets as Record<string, unknown>;
      for (const key of joined) delete map[key];
      map[INFRA_NETWORK] = null;
    }
  }

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

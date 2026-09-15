import { isMap, isScalar, isSeq, type YAMLMap } from "../../yaml";

import { composeTruthy } from "../../deploy/compose-lint/document";

import { DOKPLOY_NETWORK } from "./source-platform";
import { stringScalar } from "./compose-yaml";

export function platformNetworkKeys(
  doc: { networks?: unknown },
  names: readonly string[],
): Set<string> {
  const keys = new Set<string>();
  const wanted = new Set(names.map((n) => n.trim()).filter(Boolean));
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    if (key === DOKPLOY_NETWORK && wanted.has(key)) keys.add(key);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const ext = n.external;
    const extName =
      ext != null && typeof ext === "object" && !Array.isArray(ext)
        ? (ext as Record<string, unknown>).name
        : null;
    const named =
      (typeof n.name === "string" && wanted.has(n.name.trim())) ||
      (typeof extName === "string" && wanted.has(extName.trim()));
    if (named || (wanted.has(key) && ext === true)) keys.add(key);
  }
  return keys;
}

export function externalNetworkKeys(doc: { networks?: unknown }): Set<string> {
  const keys = new Set<string>();
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const ext = (raw as Record<string, unknown>).external;
    const pinned =
      ext != null && typeof ext === "object" && !Array.isArray(ext);
    if (pinned || composeTruthy(ext)) keys.add(key);
  }
  return keys;
}

const NETWORK_MODE_KEYWORDS = new Set(["none", "host", "bridge", "default"]);

export function stripHostNetworkMode(
  service: string,
  holder: YAMLMap,
  changes: string[],
): void {
  const node = stringScalar(holder, "network_mode");
  const value = node ? (node.value as string).trim() : "";
  if (!value) return;
  if (NETWORK_MODE_KEYWORDS.has(value.toLowerCase())) return;
  if (/^(service|container):/i.test(value)) return;
  holder.delete("network_mode");
  changes.push(
    `\`network_mode: ${value}\` on ${service} named a network on the server, so it did not come across - the service is on its Environment's network here.`,
  );
}

export function stripNetworks(holder: YAMLMap, keys: Set<string>): void {
  const node = holder.get("networks", true);
  if (isSeq(node)) {
    node.items = node.items.filter(
      (entry) => !keys.has(String(isScalar(entry) ? entry.value : entry)),
    );
    if (node.items.length === 0) holder.delete("networks");
  } else if (isMap(node)) {
    for (const key of keys) node.delete(key);
    if (node.items.length === 0) holder.delete("networks");
  }
}

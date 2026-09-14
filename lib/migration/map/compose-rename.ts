import { isMap, isScalar, isSeq, Scalar, type YAMLMap } from "../../yaml";

import { renameHostTokens } from "./env";
import { readComposeDoc, serviceLikeMaps, stringScalar } from "./compose-yaml";

/** The `environment:` block in either of its two shapes. */
function rewriteEnvNode(node: unknown, renames: Map<string, string>): void {
  if (isMap(node)) {
    for (const item of node.items) {
      const value = item.value;
      if (!isScalar(value) || typeof value.value !== "string") continue;
      const e = {
        key: String((item.key as Scalar).value),
        value: value.value,
      };
      if (renameHostTokens([e], renames).length > 0) value.value = e.value;
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const raw: string = item.value;
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      const e = { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
      if (renameHostTokens([e], renames).length > 0)
        item.value = `${e.key}=${e.value}`;
    }
  }
}

/**
 * Rename every service whose DNS name a neighbour on the destination network
 * already answers to, and carry the references with it. An Environment is one
 * network (ADR-0028), and two stacks both calling their database `db` is ordinary.
 */
export function renameClashingServices(
  source: string,
  /** Lowercase names a neighbour answers to on the destination network. */
  taken: Set<string>,
  /** Qualify a renamed service with the app's own name, or `null` for `<name>-2`. */
  prefix: string | null,
  /** Every name on the network, when `taken` was narrowed to what clashes: the
   *  free name is picked against this, so a third `db` skips the `db-2` too. */
  avoid: Set<string> = taken,
): { compose: string; renames: Map<string, string>; changes: string[] } {
  const renames = new Map<string, string>();
  const unchanged = { compose: source, renames, changes: [] as string[] };
  if (taken.size === 0) return unchanged;
  const doc = readComposeDoc(source);
  if (!doc) return unchanged;
  const root = doc.contents as YAMLMap;
  const services = root.get("services", true);
  if (!isMap(services)) return unchanged;

  const base =
    prefix === null
      ? null
      : prefix
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "app";
  const used = new Set(
    services.items.map((i) => String((i.key as Scalar).value).toLowerCase()),
  );
  const changes: string[] = [];
  /** A free name for `name`: qualified by this app, or numbered like a slug. */
  const freeName = (name: string): string => {
    const stem = base === null ? name : `${base}-${name}`;
    let next = base === null ? `${stem}-2` : stem;
    for (
      let i = base === null ? 3 : 2;
      taken.has(next.toLowerCase()) ||
      avoid.has(next.toLowerCase()) ||
      used.has(next.toLowerCase());
      i++
    )
      next = `${stem}-${i}`;
    used.add(next.toLowerCase());
    return next;
  };

  for (const item of services.items) {
    const key = item.key as Scalar;
    const name = String(key.value);
    if (!taken.has(name.toLowerCase())) continue;
    const next = freeName(name);
    key.value = next;
    renames.set(name.toLowerCase(), next);
    changes.push(
      `\`${name}\` is already answered by something else on this environment's network, so this stack's service is \`${next}\` here - everything that named it came with it.`,
    );
  }

  // `hostname:` is registered in Docker's DNS exactly like a service name, so a
  // stack that renamed no service can still be claiming a taken one.
  for (const { map: holder } of serviceLikeMaps(root)) {
    const host = stringScalar(holder, "hostname");
    if (!host) continue;
    const name = (host.value as string).trim();
    if (!taken.has(name.toLowerCase())) continue;
    const next = renames.get(name.toLowerCase()) ?? freeName(name);
    host.value = next;
    if (!renames.has(name.toLowerCase())) {
      renames.set(name.toLowerCase(), next);
      changes.push(
        `Its \`hostname: ${name}\` is already answered on this environment's network, so it is \`${next}\` here.`,
      );
    }
  }

  if (renames.size === 0) return unchanged;

  for (const { map: holder } of serviceLikeMaps(root)) {
    const dep = holder.get("depends_on", true);
    if (isSeq(dep))
      for (const item of dep.items) {
        if (!isScalar(item) || typeof item.value !== "string") continue;
        const to = renames.get(item.value.trim().toLowerCase());
        if (to) item.value = to;
      }
    else if (isMap(dep))
      for (const item of dep.items) {
        const key = item.key as Scalar;
        const to = renames.get(String(key.value).trim().toLowerCase());
        if (to) key.value = to;
      }

    const links = holder.get("links", true);
    if (isSeq(links))
      for (const item of links.items) {
        if (!isScalar(item) || typeof item.value !== "string") continue;
        const [named, alias] = item.value.split(":");
        const to = renames.get(named.trim().toLowerCase());
        if (to) item.value = alias ? `${to}:${alias}` : to;
      }

    rewriteEnvNode(holder.get("environment", true), renames);
  }

  return { compose: String(doc), renames, changes };
}

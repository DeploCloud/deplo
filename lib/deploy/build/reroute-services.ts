import { parse } from "yaml";

// A domain change re-applies routing only (ADR-0048, decision of 22 Nov 2026): only the services whose rendering
// changed come up again, without their dependencies.

type Doc = { services?: Record<string, unknown> } & Record<string, unknown>;

const read = (yaml: string): Doc | null => {
  try {
    const d = parse(yaml) as unknown;
    return d && typeof d === "object" ? (d as Doc) : null;
  } catch {
    return null;
  }
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The services a reroute from `before` to `after` must bring up, or null when the whole stack must come up: a
 * service gone, or a change outside `services` (networks, volumes, configs) that every service may read.
 */
export function changedServices(
  before: string,
  after: string,
): string[] | null {
  const a = read(before);
  const b = read(after);
  if (!a?.services || !b?.services) return null;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (key !== "services" && !same(a[key], b[key])) return null;
  if (Object.keys(a.services).some((name) => !(name in b.services!)))
    return null;
  return Object.keys(b.services).filter(
    (name) => !same(a.services![name], b.services![name]),
  );
}

/** One short line for a failed `compose up`: what failed, never the raw output. */
export function composeFailureLine(stderr: string): string {
  const lines = stderr
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const service = (raw: string) =>
    raw.replace(/^deplo-[a-z0-9-]+?-([a-z0-9_.-]+?)-\d+$/i, "$1");
  const find = (re: RegExp) => lines.map((l) => l.match(re)).find(Boolean);
  let m = find(/dependency failed to start: container (\S+) is unhealthy/i);
  if (m) return `${service(m[1])} did not pass its health check`;
  m = find(/Container (\S+)\s+Error\s+(.+)$/i);
  if (m) return `${service(m[1])}: ${m[2]}`.slice(0, 200);
  m = find(/Error response from daemon: (.+)$/i);
  if (m) return m[1].slice(0, 200);
  return (lines.at(-1) ?? "the proxy's routes were not applied").slice(0, 200);
}

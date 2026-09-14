import "server-only";

import { interpolates } from "../compose-lint/document";
import type { App } from "./types";

// deploLabels are the labels that mark a container as Deplo-owned.
export function deploLabels(appId: string, slug: string): string[] {
  return ["deplo.managed=true", `deplo.project=${appId}`, `deplo.slug=${slug}`];
}

// Merge label strings into an existing array/map `labels` block, dropping any entry
// whose KEY collides (so re-deploys don't accumulate stale routing/tracking labels).
function mergeLabelEntries(labels: unknown, add: string[]): string[] {
  const keyOf = (l: string): string => l.split("=")[0];
  const incoming = new Set(add.map(keyOf));
  const existing: string[] = [];
  if (Array.isArray(labels)) {
    for (const l of labels) {
      if (typeof l === "string" && !incoming.has(keyOf(l))) existing.push(l);
    }
  } else if (labels && typeof labels === "object") {
    for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
      if (!incoming.has(k)) existing.push(`${k}=${String(v)}`);
    }
  }
  return [...existing, ...add];
}

// stripTraefikLabels drops every user-authored `traefik.*` label from a service, before
// Deplo injects its own domains-derived routers. Match is case-insensitive because
// Docker lowercases label keys.
export function stripTraefikLabels(svc: App): void {
  const isTraefik = (key: string): boolean => /^traefik\./i.test(key.trim());
  if (Array.isArray(svc.labels)) {
    // A LIST entry is one value, so `- "${LBL}"` becomes a whole `key=value` pair at
    // `compose up` - a router rule claiming any hostname, past this strip and past
    // every check that reads the authored text. Dropped by its KEY.
    svc.labels = svc.labels.filter(
      (l) =>
        !(
          typeof l === "string" &&
          (isTraefik(l.split("=")[0]) || interpolates(l.split("=")[0]))
        ),
    );
  } else if (svc.labels && typeof svc.labels === "object") {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      svc.labels as Record<string, unknown>,
    )) {
      if (!isTraefik(k)) kept[k] = v;
    }
    svc.labels = kept;
  }
}

// mergeLabels merges new label strings into a service's own `labels`.
export function mergeLabels(svc: App, add: string[]): void {
  svc.labels = mergeLabelEntries(svc.labels, add);
}

// mergeBuildLabels stamps the Deplo tracking labels ONTO THE IMAGE a `build:` section
// produces, plus `deplo.service=<name>` so the agent can rank each service's
// generations apart.
export function mergeBuildLabels(
  svc: App,
  service: string,
  tracking: string[],
): void {
  const b = (svc as Record<string, unknown>).build;
  if (b === undefined || b === null) return;
  const build: Record<string, unknown> =
    typeof b === "string" ? { context: b } : (b as Record<string, unknown>);
  build.labels = mergeLabelEntries(build.labels, [
    ...tracking,
    `deplo.service=${service}`,
  ]);
  (svc as Record<string, unknown>).build = build;
}

// mergeEnvironment injects the project's settings env-var KEYS into a service's
// `environment:` as bare `- KEY` pass-throughs (the value comes from the `--env-file`),
// so a var added in settings reaches the container without the user hand-writing it.
export function mergeEnvironment(svc: App, keys: string[]): void {
  if (keys.length === 0) return;
  const nameOf = (entry: string): string => entry.split("=")[0].trim();
  const existing: string[] = [];
  const declared = new Set<string>();
  const env = svc.environment;
  if (Array.isArray(env)) {
    for (const e of env) {
      if (typeof e === "string") {
        existing.push(e);
        declared.add(nameOf(e));
      }
    }
  } else if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      // A null map value (`KEY:`) is compose's own pass-through form - emit the bare
      // key, not `KEY=null`, so it keeps reading from the env-file.
      existing.push(v === null || v === undefined ? k : `${k}=${String(v)}`);
      declared.add(k);
    }
  }
  const added = keys.filter((k) => !declared.has(k));
  // Nothing new to inject ⇒ leave the service untouched: rewriting a map to a list
  // would churn the YAML and restart the container on a reroute.
  if (added.length === 0) return;
  svc.environment = [...existing, ...added];
}

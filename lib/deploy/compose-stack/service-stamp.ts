import "server-only";

import { labelEntries, readTraefikLabel } from "../compose-lint/traefik-labels";
import { RESTART_LABEL } from "../restart-under-lease";
import type { App } from "./types";

export function deploLabels(appId: string, slug: string): string[] {
  return ["deplo.managed=true", `deplo.project=${appId}`, `deplo.slug=${slug}`];
}

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

// Keeps a supported middleware under a name only this stack can hold; every other Traefik label goes.
export function takeTraefikLabels(
  svc: App,
  prefix: string,
): { middlewares: string[]; ignored: string[] } {
  const middlewares: string[] = [];
  const ignored: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of labelEntries(svc.labels)) {
    const label = readTraefikLabel(key);
    if (label.kind === "other")
      kept.push(value === undefined ? key : `${key}=${value}`);
    else if (label.kind === "ignored") ignored.push(key.trim());
    else if (label.kind === "middleware") {
      const name = `${prefix}-${label.name}`;
      if (!middlewares.includes(name)) middlewares.push(name);
      kept.push(
        `traefik.http.middlewares.${name}.${label.option}=${value ?? ""}`,
      );
    }
  }
  if (svc.labels !== undefined) svc.labels = kept;
  return { middlewares, ignored };
}

export function mergeLabels(svc: App, add: string[]): void {
  svc.labels = mergeLabelEntries(svc.labels, add);
}

/**
 * Turns a service's restart policy off, kept in RESTART_LABEL for the agent. One with no policy is kept up
 * (`unless-stopped`), unless it is a step others wait to finish; a written "no" stays as it is.
 */
export function leaseRestart(svc: App, runsOnce = false): void {
  const written =
    typeof svc.restart === "string" ? svc.restart.split(":")[0].trim() : "";
  const policy = written || (runsOnce ? "" : "unless-stopped");
  if (!policy || policy === "no") return;
  svc.restart = "no";
  mergeLabels(svc, [`${RESTART_LABEL}=${policy}`]);
}

/** The services another one waits to see finish (`service_completed_successfully`): steps that run once. */
export function servicesThatRunOnce(
  services: Record<string, App>,
): Set<string> {
  const out = new Set<string>();
  for (const svc of Object.values(services)) {
    const deps = (svc as { depends_on?: unknown } | null)?.depends_on;
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const [name, d] of Object.entries(deps as Record<string, unknown>))
      if (
        (d as { condition?: unknown } | null)?.condition ===
        "service_completed_successfully"
      )
        out.add(name);
  }
  return out;
}

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
      existing.push(v === null || v === undefined ? k : `${k}=${String(v)}`);
      declared.add(k);
    }
  }
  const added = keys.filter((k) => !declared.has(k));
  if (added.length === 0) return;
  svc.environment = [...existing, ...added];
}

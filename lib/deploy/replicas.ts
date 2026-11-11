import type { App } from "../types/app";
import { servicesOf } from "./compose-lint/document";
import { isFilesConventionSource } from "./compose-lint/volumes";

// The agent runs several copies of one App and waits for every one before an old one stops.
export const REPLICAS_CAPABILITY = "deploy.replicas";

export const MAX_REPLICAS = 10;

export const REPLICAS_DATA_MESSAGE =
  "An App that keeps data on its own disk runs one copy. Keep the data in a database to run more.";

export const REPLICAS_AGENT_MESSAGE =
  "This server's agent is too old to run more than one copy of an App. Deplo updates the agent on its own.";

export function cleanReplicas(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPLICAS)
    throw new Error(
      `Replicas must be a whole number from 1 to ${MAX_REPLICAS}`,
    );
  return n;
}

// A Volume or a Bind keeps data on the server's disk, a published port is held by one copy; Files are fine.
export function appKeepsDataOnDisk(
  app: Pick<App, "volumes" | "ports">,
): boolean {
  return (
    (app.volumes ?? []).some((v) => v.type !== "app") ||
    (app.ports ?? []).length > 0
  );
}

// The one guard: the message to show when this App may not run `replicas` copies.
export function replicasRefusal(
  app: Pick<App, "volumes" | "ports">,
  replicas: number,
): string | null {
  return replicas > 1 && appKeepsDataOnDisk(app) ? REPLICAS_DATA_MESSAGE : null;
}

// Services of a compose stack that ask for several copies and keep data on disk or hold a host port.
export function composeReplicasConflicts(composeYaml: string): string[] {
  const services = servicesOf(composeYaml);
  if (!services) return [];
  const out: string[] = [];
  for (const [name, raw] of Object.entries(services)) {
    // A count a variable fills in may be any number: where one copy is the rule, it is refused as written.
    if (
      (composeServiceReplicas(raw) > 1 || replicasAreInterpolated(raw)) &&
      serviceKeepsOneCopy(raw)
    )
      out.push(name);
  }
  return out;
}

function replicasAreInterpolated(svc: unknown): boolean {
  const n = (svc as { deploy?: { replicas?: unknown } } | null)?.deploy
    ?.replicas;
  return typeof n === "string" && n.includes("$");
}

// `--scale web=3` in the extra compose flags: the same rule by another door.
export function scaleConflicts(
  composeYaml: string | null | undefined,
  composeUpArgs: string | null | undefined,
): string[] {
  const services = servicesOf(composeYaml ?? "");
  if (!services) return [];
  const tokens = (composeUpArgs ?? "").trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  tokens.forEach((token, i) => {
    const value = token.startsWith("--scale=")
      ? token.slice("--scale=".length)
      : tokens[i - 1] === "--scale"
        ? token
        : null;
    const [name, count] = (value ?? "").split("=");
    if (name && Number(count) > 1 && serviceKeepsOneCopy(services[name]))
      out.push(name);
  });
  return out;
}

// A named volume, a host path or a published host port: what two copies of a service cannot share.
export function serviceKeepsOneCopy(raw: unknown): boolean {
  const svc = raw as { volumes?: unknown; ports?: unknown } | null;
  if (!svc || typeof svc !== "object") return false;
  const ports = Array.isArray(svc.ports)
    ? svc.ports.some((p) => p != null && p !== "")
    : svc.ports != null;
  return (
    ports || (Array.isArray(svc.volumes) ? svc.volumes : []).some(mountsDisk)
  );
}

export function composeServiceReplicas(svc: unknown): number {
  const n = Number(
    (svc as { deploy?: { replicas?: unknown } } | null)?.deploy?.replicas,
  );
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// A named volume or a host path; Files (`./x`), an anonymous volume and a tmpfs are one per copy.
function mountsDisk(v: unknown): boolean {
  let source: string | null = null;
  if (typeof v === "string") {
    const i = v.indexOf(":");
    source = i > 0 ? v.slice(0, i) : null;
  } else if (v && typeof v === "object") {
    const rec = v as { source?: unknown; type?: unknown };
    if (rec.type === "tmpfs") return false;
    source = typeof rec.source === "string" ? rec.source : null;
  }
  return source !== null && !isFilesConventionSource(source);
}

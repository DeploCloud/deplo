import yaml from "../../yaml";

export function composeMountPaths(
  compose: string | null | undefined,
): string[] {
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(compose ?? "") as typeof doc;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const svc of Object.values(doc?.services ?? {})) {
    const mounts = svc?.volumes;
    if (!Array.isArray(mounts)) continue;
    for (const raw of mounts) {
      let dest: string | undefined;
      if (typeof raw === "string") {
        const parts = raw.split(":");
        dest = (parts.length > 1 ? parts[1] : parts[0])?.trim();
      } else if (raw && typeof raw === "object")
        dest = (raw as { target?: string }).target?.trim();
      if (dest) out.push(dest.replace(/\/+$/, ""));
    }
  }
  return out;
}

export function composeServices(compose: string | null | undefined): string[] {
  try {
    const doc = yaml.load(compose ?? "") as { services?: unknown } | null;
    const services = doc?.services;
    if (!services || typeof services !== "object" || Array.isArray(services))
      return [];
    return Object.keys(services as Record<string, unknown>);
  } catch {
    return [];
  }
}

export function composeServiceExposingPort(
  compose: string | null | undefined,
): string | null {
  let doc: {
    services?: Record<string, { ports?: unknown; expose?: unknown }>;
  } | null;
  try {
    doc = yaml.load(compose ?? "") as typeof doc;
  } catch {
    return null;
  }
  const services = Object.entries(doc?.services ?? {});
  if (services.length === 0) return null;
  if (services.length === 1) return services[0][0];
  const exposing = services.filter(
    ([, svc]) =>
      (Array.isArray(svc?.ports) && svc.ports.length > 0) ||
      (Array.isArray(svc?.expose) && svc.expose.length > 0),
  );
  return exposing.length === 1 ? exposing[0][0] : null;
}

export interface ComposeRepoApp {
  service: string;
  dockerfilePath?: string;
  dockerContextPath?: string;
  dockerBuildStage?: string;
}

export function composeAsRepoApp(compose: string): ComposeRepoApp | null {
  let doc: {
    services?: Record<
      string,
      {
        image?: unknown;
        build?: unknown;
        depends_on?: unknown;
      }
    >;
  } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return null;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return null;
  const keys = Object.keys(services);
  if (keys.length !== 1) return null;

  const key = keys[0]!;
  const svc = services[key];
  if (!svc || typeof svc !== "object") return null;
  if (!svc.build) return null;
  if (svc.depends_on) return null;

  const out: ComposeRepoApp = { service: key };
  if (typeof svc.build === "object" && !Array.isArray(svc.build)) {
    const b = svc.build as Record<string, unknown>;
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const ctx = str(b.context);
    if (ctx && ctx !== ".") out.dockerContextPath = ctx;
    out.dockerfilePath = str(b.dockerfile);
    out.dockerBuildStage = str(b.target);
  }
  return out;
}

export function composeBuildServices(compose: string): string[] {
  let doc: { services?: Record<string, { build?: unknown }> } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  return Object.entries(services)
    .filter(([, s]) => s && typeof s === "object" && s.build)
    .map(([k]) => k);
}

import { loadComposeDoc, servicesOf } from "../deploy/compose-lint/document";
import { deriveVolumeName, VOLUME_NAME_MAX } from "./volume-model";
import type { VolumeMount } from "../types/container";

// Every volume is data: a place the image declares, or a compose volume with no name, becomes a Volume.
// https://deplo.build/docs/guides/data/persistent-storage#volumes-the-image-declares

/** A place Docker would give an unnamed volume. `service` null: a single-image App's one container. */
export interface UnnamedPlace {
  service: string | null;
  path: string;
  origin: "image" | "compose";
}

const clean = (p: string) => p.trim().replace(/\/+$/, "");

type Entry = { source: string | null; target: string } | null;

function entryOf(v: unknown): Entry {
  if (typeof v === "string") {
    const parts = v.split(":");
    if (parts.length === 1) return { source: null, target: clean(parts[0]) };
    return { source: parts[0].trim() || null, target: clean(parts[1] ?? "") };
  }
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    if (typeof r.target !== "string") return null;
    const type = typeof r.type === "string" ? r.type : "volume";
    const source = typeof r.source === "string" && r.source ? r.source : null;
    return {
      source: type === "volume" ? source : (source ?? type),
      target: clean(r.target),
    };
  }
  return null;
}

/** A compose volume entry that names nothing (`- /data`, or `type: volume` with no source). */
export function isUnnamedEntry(v: unknown): boolean {
  const e = entryOf(v);
  return e !== null && e.source === null && e.target.startsWith("/");
}

/** The paths an entry list mounts with a source: these are never Docker's to name. */
function mountedPaths(vols: unknown): Set<string> {
  const out = new Set<string>();
  for (const v of Array.isArray(vols) ? vols : []) {
    const e = entryOf(v);
    if (e?.source) out.add(e.target);
  }
  return out;
}

/** The published image a compose service runs, or null when it builds one or names it by a variable. */
export function serviceImage(svc: unknown): string | null {
  const s = (svc ?? {}) as { image?: unknown; build?: unknown };
  if (s.build != null || typeof s.image !== "string") return null;
  const image = s.image.trim();
  return image && !image.includes("$") ? image : null;
}

/**
 * The places of a stack (or one image) Docker would leave unnamed, minus those a Volume already holds.
 * `declared` maps a service (or "" for a single image) to the paths its image declares.
 */
export function unnamedPlaces(
  app: {
    compose?: string | null;
    composeStack: boolean;
    volumes?: readonly Pick<VolumeMount, "service" | "mountPath">[] | null;
  },
  declared: ReadonlyMap<string, readonly string[]>,
): UnnamedPlace[] {
  const held = new Set(
    (app.volumes ?? []).map(
      (v) => `${(v.service ?? "").trim()}|${clean(v.mountPath)}`,
    ),
  );
  const out: UnnamedPlace[] = [];
  const add = (
    service: string | null,
    path: string,
    origin: UnnamedPlace["origin"],
  ) => {
    const key = `${service ?? ""}|${path}`;
    if (!path.startsWith("/") || held.has(key)) return;
    held.add(key);
    out.push({ service, path, origin });
  };
  if (!app.composeStack) {
    for (const p of declared.get("") ?? []) add(null, clean(p), "image");
    return out;
  }
  for (const [name, svc] of Object.entries(
    servicesOf(app.compose ?? null) ?? {},
  )) {
    const vols = (svc as { volumes?: unknown } | null)?.volumes;
    for (const v of Array.isArray(vols) ? vols : [])
      if (isUnnamedEntry(v)) add(name, entryOf(v)!.target, "compose");
    const mounted = mountedPaths(vols);
    for (const p of declared.get(name) ?? [])
      if (!mounted.has(clean(p))) add(name, clean(p), "image");
  }
  return out;
}

/** A Volume name for a place, unique among `taken`: `fise-db-data` for fise-db's /var/lib/postgresql/data. */
export function unnamedVolumeName(
  place: UnnamedPlace,
  taken: Set<string>,
): string {
  const last = place.path.split("/").filter(Boolean).at(-1) ?? "data";
  const base = deriveVolumeName(
    place.service ? `${place.service}-${last}` : last,
  ).slice(0, VOLUME_NAME_MAX - 3);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/** What the agent carries over at this deploy: each mount of a rendered stack onto one of `names`. */
export function volumeAdoptions(
  renderedYaml: string,
  names: ReadonlySet<string>,
): { service: string; target: string; volume: string }[] {
  if (names.size === 0) return [];
  const doc = loadComposeDoc<{
    services?: Record<string, { volumes?: unknown } | null>;
    volumes?: Record<string, { name?: unknown } | null>;
  }>(renderedYaml);
  const top = doc?.volumes ?? {};
  const out: { service: string; target: string; volume: string }[] = [];
  for (const [service, svc] of Object.entries(doc?.services ?? {})) {
    const vols = svc?.volumes;
    for (const v of Array.isArray(vols) ? vols : []) {
      const e = entryOf(v);
      const name = e?.source ? top[e.source]?.name : undefined;
      if (typeof name === "string" && names.has(name))
        out.push({ service, target: e!.target, volume: name });
    }
  }
  return out;
}

import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listTags } from "@/lib/registry/client";
import type { DatabaseType } from "@/lib/types";

/**
 * Real, current engine versions for the database "Version" autocomplete — synced
 * live from Docker Hub so the list tracks new releases (e.g. Postgres 18)
 * automatically, instead of a hardcoded list that goes stale. Proxied
 * server-side behind a short-lived, process-wide cache so every dashboard client
 * shares one upstream call per engine per TTL (same pattern as
 * `/api/node-versions`). Auth-gated.
 *
 * The stored value is a bare version the DB image mapping appends its suffix to
 * (`postgres:${v}-alpine`, `mysql:${v}`, …), so we keep only clean numeric tags
 * (`18`, `18.1`, `8.4`) and drop the `-alpine`/`-bookworm`/`latest` variants —
 * they'd break the derived image ref. Free text is still allowed in the combobox
 * for anything the list doesn't cover.
 *
 *   GET /api/database-versions?engine=postgres
 *     → { versions: [{ value: "18", label: "18" }, { value: "17.6", label: "17.6" }, …] }
 */

// The Docker Hub repo whose tags back each engine (mirrors DB_IMAGES in
// lib/deploy/database-compose.ts). `listTags` expands bare Hub names to
// `library/…` itself; clickhouse ships under its own org.
const HUB_REPO: Record<DatabaseType, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  redis: "redis",
  clickhouse: "clickhouse/clickhouse-server",
};

// Recent, real majors per engine — the offline fallback AND a floor merged into
// the live list so common versions are always present even when Hub returns a
// thin batch. Keep these current; the live fetch is the real source of truth.
const FALLBACK: Record<DatabaseType, string[]> = {
  postgres: ["18", "17", "16", "15"],
  mysql: ["9.1", "8.4", "8.0"],
  mariadb: ["11", "10"],
  mongodb: ["8", "7", "6"],
  redis: ["8", "7"],
  clickhouse: ["25", "24"],
};

const TTL_MS = 6 * 60 * 60 * 1000; // 6h — engine majors change slowly.
const cache = new Map<DatabaseType, { at: number; versions: string[] }>();

function isEngine(v: string | null): v is DatabaseType {
  return v != null && v in HUB_REPO;
}

/** Clean numeric tag ("18", "18.1", "8.4"); rejects "18-alpine", "latest", "". */
function isCleanVersion(tag: string): boolean {
  return /^\d+(\.\d+){0,2}$/.test(tag);
}

/** Descending semantic-ish sort (18 before 17.6 before 17 before 16). */
function compareDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? -1) - (pa[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

async function versionsFor(engine: DatabaseType): Promise<string[]> {
  const hit = cache.get(engine);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.versions;

  let live: string[] = [];
  try {
    // A generous batch (Hub orders by last_updated, so recent majors/minors are
    // near the top among many variant tags we filter out).
    const tags = await listTags(HUB_REPO[engine], 100);
    live = tags.map((t) => t.name).filter(isCleanVersion);
  } catch {
    // Unreachable / rate-limited: fall back to the floor below.
  }

  const merged = Array.from(new Set([...live, ...FALLBACK[engine]])).sort(
    compareDesc,
  );
  // Cap so the dropdown stays scannable; free text covers anything trimmed.
  const versions = merged.slice(0, 40);
  cache.set(engine, { at: Date.now(), versions });
  return versions;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const engine = request.nextUrl.searchParams.get("engine");
  if (!isEngine(engine))
    return Response.json({ error: "Unknown engine" }, { status: 400 });

  const versions = await versionsFor(engine);
  return Response.json({
    versions: versions.map((v) => ({ value: v, label: v })),
  });
}

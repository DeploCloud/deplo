import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listTags } from "@/lib/registry/client";
import type { DatabaseType } from "@/lib/types/database";

// Mirrors DB_IMAGES in lib/deploy/database-compose.ts; `listTags` expands bare Hub names to `library/…` itself.
const HUB_REPO: Record<DatabaseType, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  redis: "redis",
  clickhouse: "clickhouse/clickhouse-server",
};

// Offline fallback AND a floor merged into the live list, so common versions are never missing.
const FALLBACK: Record<DatabaseType, string[]> = {
  postgres: ["18", "17", "16", "15"],
  mysql: ["9.1", "8.4", "8.0"],
  mariadb: ["11", "10"],
  mongodb: ["8", "7", "6"],
  redis: ["8", "7"],
  clickhouse: ["25.8", "25.3", "24"],
};

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<DatabaseType, { at: number; versions: string[] }>();

function isEngine(v: string | null): v is DatabaseType {
  return v != null && Object.hasOwn(HUB_REPO, v);
}

// Hub tag lists are mostly variants ("18-alpine", "latest"); only clean numerics are real versions.
function isCleanVersion(tag: string): boolean {
  return /^\d+(\.\d+){0,2}$/.test(tag);
}

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
    // Hub orders by last_updated, so recent majors sit near the top of the batch.
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

import "server-only";

import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { envExampleKeys, envVars } from "../db/schema/control-plane/env-vars";
import { getCurrentUser } from "../auth/current-user";
import { openRepoRoot } from "../apps/framework-source";
import { resolveBuildDir } from "../deploy/source";
import { KEY_RE, parseEnvFile, type EnvFileEntry } from "../env-file";
import { newId, nowIso } from "../ids";
import type { GitRepo } from "../types/build";
import { recordActivity } from "./activity";
import { instanceFrozen } from "./deplo-move/freeze";
import { hasAppCapability, requireAppCapability } from "./node-access";

// In this order: the first one a repo has is the list of what the app needs.
export const ENV_EXAMPLE_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template",
];

const MAX_BYTES = 200_000;

export interface EnvExampleKeyDTO {
  id: string;
  key: string;
  note: string | null;
  example: string | null;
  seenAt: string;
}

export function pickEnvExample(files: readonly string[]): string | null {
  return ENV_EXAMPLE_FILES.find((name) => files.includes(name)) ?? null;
}

export interface EnvExamplePlan {
  insert: EnvFileEntry[];
  update: EnvFileEntry[];
  remove: string[];
}

// The file is the truth: a name it lists is kept, refreshed or added, a name it dropped goes,
// a dismissed one with it, so listing it again brings it back.
export function planEnvExampleSync(
  entries: readonly EnvFileEntry[],
  stored: readonly string[],
): EnvExamplePlan {
  const listed = entries.filter((e) => KEY_RE.test(e.key));
  const have = new Set(stored);
  const keys = new Set(listed.map((e) => e.key));
  return {
    insert: listed.filter((e) => !have.has(e.key)),
    update: listed.filter((e) => have.has(e.key)),
    remove: stored.filter((k) => !keys.has(k)),
  };
}

// Reads the file's names into the table; returns how many of them are new and still unset.
export async function syncEnvExample(
  appId: string,
  text: string,
): Promise<number> {
  const db = getDb();
  const stored = await db
    .select({ key: envExampleKeys.key })
    .from(envExampleKeys)
    .where(eq(envExampleKeys.appId, appId));
  const plan = planEnvExampleSync(
    parseEnvFile(text),
    stored.map((r) => r.key),
  );
  const now = nowIso();
  const inserted = await db.transaction(async (tx) => {
    if (plan.remove.length > 0)
      await tx
        .delete(envExampleKeys)
        .where(
          and(
            eq(envExampleKeys.appId, appId),
            inArray(envExampleKeys.key, plan.remove),
          ),
        );
    for (const e of plan.update)
      await tx
        .update(envExampleKeys)
        .set({ note: e.note ?? null, example: e.value || null, updatedAt: now })
        .where(
          and(eq(envExampleKeys.appId, appId), eq(envExampleKeys.key, e.key)),
        );
    if (plan.insert.length === 0) return [];
    return tx
      .insert(envExampleKeys)
      .values(
        plan.insert.map((e) => ({
          id: newId("envx"),
          appId,
          key: e.key,
          note: e.note ?? null,
          example: e.value || null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ key: envExampleKeys.key });
  });
  if (inserted.length === 0) return 0;
  const set = await db
    .select({ key: envVars.key })
    .from(envVars)
    .where(
      and(
        eq(envVars.appId, appId),
        inArray(
          envVars.key,
          inserted.map((r) => r.key),
        ),
      ),
    );
  const found = inserted.length - set.length;
  if (found > 0)
    await recordActivity(
      "env",
      `Found ${found} new variable${found === 1 ? "" : "s"} to fill in .env.example`,
      "Deplo",
      appId,
    );
  return found;
}

// Never on the deploy's path: a slow or failing provider costs the list, not the deploy.
export function autoReadEnvExample(
  appId: string,
  repo: GitRepo,
  rootDirectory: string | null | undefined,
): void {
  void (async () => {
    if (await instanceFrozen()) return;
    const root = await openRepoRoot(repo, rootDirectory);
    const name = root && pickEnvExample(root.files);
    if (!name) return;
    const text = await root.read(name);
    if (text !== null) await syncEnvExample(appId, text);
  })().catch(() => {});
}

export async function autoReadEnvExampleFromTree(
  appId: string,
  root: string,
  rootDirectory: string | null | undefined,
): Promise<void> {
  try {
    if (await instanceFrozen()) return;
    const dir = await resolveBuildDir({
      root,
      rootDirectory,
      failOnMissing: false,
    }).catch(() => root);
    const files: string[] = [];
    for await (const entry of await opendir(dir))
      if (entry.isFile()) files.push(entry.name);
    const name = pickEnvExample(files);
    if (!name) return;
    const path = join(dir, name);
    if ((await stat(path)).size > MAX_BYTES) return;
    await syncEnvExample(appId, await readFile(path, "utf8"));
  } catch {}
}

// What still needs a value: listed, not dismissed, and no variable of that name yet.
export async function listEnvExampleKeys(
  appId: string,
): Promise<EnvExampleKeyDTO[]> {
  if (!(await hasAppCapability(appId, "manage_env"))) return [];
  const rows = await getDb()
    .select({
      id: envExampleKeys.id,
      key: envExampleKeys.key,
      note: envExampleKeys.note,
      example: envExampleKeys.example,
      seenAt: envExampleKeys.createdAt,
    })
    .from(envExampleKeys)
    .leftJoin(
      envVars,
      and(
        eq(envVars.appId, envExampleKeys.appId),
        eq(envVars.key, envExampleKeys.key),
      ),
    )
    .where(
      and(
        eq(envExampleKeys.appId, appId),
        eq(envExampleKeys.dismissed, false),
        isNull(envVars.id),
      ),
    )
    .orderBy(asc(envExampleKeys.createdAt), asc(envExampleKeys.key));
  return rows;
}

export async function dismissEnvExampleKey(id: string): Promise<void> {
  const user = (await getCurrentUser())!;
  const [row] = await getDb()
    .select({ appId: envExampleKeys.appId, key: envExampleKeys.key })
    .from(envExampleKeys)
    .where(eq(envExampleKeys.id, id));
  if (!row) throw new Error("Not found");
  await requireAppCapability(row.appId, "manage_env");
  const done = await getDb()
    .update(envExampleKeys)
    .set({ dismissed: true, updatedAt: nowIso() })
    .where(and(eq(envExampleKeys.id, id), eq(envExampleKeys.appId, row.appId)))
    .returning({ id: envExampleKeys.id });
  if (done.length === 0) throw new Error("Not found");
  await recordActivity(
    "env",
    `Removed ${row.key} from the variables .env.example asks for`,
    user.name,
    row.appId,
  );
}

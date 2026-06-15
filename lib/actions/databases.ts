"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  createDatabase,
  deleteDatabase,
  setDatabaseRunning,
  getConnectionString,
} from "@/lib/data/databases";

const createSchema = z.object({
  name: z.string().min(1).max(63),
  type: z.enum(["postgres", "mysql", "mariadb", "mongodb", "redis", "clickhouse"]),
  version: z.string().min(1).max(20),
  exposedPublicly: z.boolean().optional(),
});

export async function createDatabaseAction(
  input: z.input<typeof createSchema>
): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(async () => {
    const db = await createDatabase(parsed.data);
    return { id: db.id };
  });
  if (res.ok) revalidatePath("/storage");
  return res;
}

export async function toggleDatabaseAction(
  id: string,
  running: boolean
): Promise<ActionResult> {
  const res = await run(() => setDatabaseRunning(id, running));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}

export async function deleteDatabaseAction(id: string): Promise<ActionResult> {
  const res = await run(() => deleteDatabase(id));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}

export async function revealConnectionAction(
  id: string
): Promise<ActionResult<{ value: string }>> {
  return run(async () => ({ value: await getConnectionString(id) }));
}

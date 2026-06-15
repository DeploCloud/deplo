"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  createBackup,
  runBackup,
  toggleBackup,
  deleteBackup,
} from "@/lib/data/backups";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  databaseId: z.string().nullable(),
  destinationId: z.string().min(1),
  schedule: z.string().min(1).max(60),
  retentionDays: z.number().int().min(1).max(3650),
});

export async function createBackupAction(
  input: z.input<typeof createSchema>
): Promise<ActionResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => createBackup(parsed.data));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}

export async function runBackupAction(id: string): Promise<ActionResult> {
  const res = await run(() => runBackup(id));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}

export async function toggleBackupAction(
  id: string,
  enabled: boolean
): Promise<ActionResult> {
  const res = await run(() => toggleBackup(id, enabled));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}

export async function deleteBackupAction(id: string): Promise<ActionResult> {
  const res = await run(() => deleteBackup(id));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}

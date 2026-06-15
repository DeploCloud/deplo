"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  upsertEnv,
  deleteEnv,
  importEnv,
  revealEnv,
} from "@/lib/data/env";

const targets = z.array(z.enum(["production", "preview", "development"])).min(1);

const upsertSchema = z.object({
  projectId: z.string().min(1),
  key: z.string().min(1).max(256),
  value: z.string().max(65536),
  targets,
  type: z.enum(["plain", "secret"]),
});

export async function upsertEnvAction(
  input: z.input<typeof upsertSchema>
): Promise<ActionResult> {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => upsertEnv(parsed.data));
  if (res.ok) revalidatePath("/projects");
  return res as ActionResult;
}

export async function deleteEnvAction(id: string): Promise<ActionResult> {
  const res = await run(() => deleteEnv(id));
  if (res.ok) revalidatePath("/projects");
  return res as ActionResult;
}

export async function importEnvAction(input: {
  projectId: string;
  blob: string;
  targets: ("production" | "preview" | "development")[];
}): Promise<ActionResult<{ count: number }>> {
  const schema = z.object({
    projectId: z.string().min(1),
    blob: z.string().max(200_000),
    targets,
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(async () => ({
    count: await importEnv(parsed.data.projectId, parsed.data.blob, parsed.data.targets),
  }));
  if (res.ok) revalidatePath("/projects");
  return res;
}

export async function revealEnvAction(
  id: string
): Promise<ActionResult<{ value: string }>> {
  return run(async () => ({ value: await revealEnv(id) }));
}

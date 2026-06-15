"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  saveSharedEnvGroup,
  deleteSharedEnvGroup,
  getSharedEnvBlob,
} from "@/lib/data/shared-env";

const saveSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(200),
  blob: z.string().max(200_000),
  projectIds: z.array(z.string()).max(200),
});

export async function saveSharedEnvGroupAction(
  input: z.input<typeof saveSchema>,
): Promise<ActionResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => saveSharedEnvGroup(parsed.data));
  if (res.ok) revalidatePath("/variables");
  return res as ActionResult;
}

export async function deleteSharedEnvGroupAction(
  id: string,
): Promise<ActionResult> {
  const res = await run(() => deleteSharedEnvGroup(id));
  if (res.ok) revalidatePath("/variables");
  return res as ActionResult;
}

export async function revealSharedEnvBlobAction(
  id: string,
): Promise<ActionResult<{ blob: string }>> {
  return run(async () => ({ blob: await getSharedEnvBlob(id) }));
}

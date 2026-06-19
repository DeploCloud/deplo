"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  saveSharedEnvGroup,
  deleteSharedEnvGroup,
  getSharedEnvBlob,
  setSharedEnvGroupAttachment,
} from "@/lib/data/shared-env";

const saveSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(200),
  blob: z.string().max(200_000),
  projectIds: z.array(z.string()).max(200),
  targets: z
    .array(z.enum(["production", "preview", "development"]))
    .min(1)
    .max(3),
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

const attachSchema = z.object({
  groupId: z.string(),
  projectId: z.string(),
  attached: z.boolean(),
});

export async function setSharedEnvGroupAttachmentAction(
  input: z.input<typeof attachSchema>,
): Promise<ActionResult> {
  const parsed = attachSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() =>
    setSharedEnvGroupAttachment(
      parsed.data.groupId,
      parsed.data.projectId,
      parsed.data.attached,
    ),
  );
  if (res.ok) {
    revalidatePath("/variables");
    revalidatePath("/projects/[slug]/environment", "page");
  }
  return res as ActionResult;
}

"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { updateProfile, updateEmail, changePassword } from "@/lib/data/account";

const profileSchema = z.object({ name: z.string().min(1).max(120) });

export async function updateProfileAction(
  input: z.input<typeof profileSchema>,
): Promise<ActionResult> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => updateProfile(parsed.data));
  if (res.ok) revalidatePath("/", "layout");
  return res as ActionResult;
}

const emailSchema = z.object({
  email: z.string().email().max(200),
  currentPassword: z.string().min(1),
});

export async function updateEmailAction(
  input: z.input<typeof emailSchema>,
): Promise<ActionResult> {
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => updateEmail(parsed.data));
  if (res.ok) revalidatePath("/", "layout");
  return res as ActionResult;
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export async function changePasswordAction(
  input: z.input<typeof passwordSchema>,
): Promise<ActionResult> {
  const parsed = passwordSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  return (await run(() => changePassword(parsed.data))) as ActionResult;
}

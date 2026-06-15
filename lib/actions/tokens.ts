"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { createToken, revokeToken } from "@/lib/data/tokens";

export async function createTokenAction(
  name: string
): Promise<ActionResult<{ raw: string }>> {
  const parsed = z.string().min(1).max(80).safeParse(name);
  if (!parsed.success) return { ok: false, error: "Name is required" };
  const res = await run(async () => {
    const { raw } = await createToken(parsed.data);
    return { raw };
  });
  if (res.ok) revalidatePath("/settings");
  return res;
}

export async function revokeTokenAction(id: string): Promise<ActionResult> {
  const res = await run(() => revokeToken(id));
  if (res.ok) revalidatePath("/settings");
  return res as ActionResult;
}

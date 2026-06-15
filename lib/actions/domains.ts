"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  addDomain,
  removeDomain,
  verifyDomain,
  setPrimaryDomain,
} from "@/lib/data/domains";

const addSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(3).max(253),
});

export async function addDomainAction(
  input: z.input<typeof addSchema>
): Promise<ActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => addDomain(parsed.data.projectId, parsed.data.name));
  if (res.ok) {
    revalidatePath("/domains");
    revalidatePath("/projects");
  }
  return res as ActionResult;
}

export async function verifyDomainAction(id: string): Promise<ActionResult> {
  const res = await run(() => verifyDomain(id));
  if (res.ok) revalidatePath("/domains");
  return res as ActionResult;
}

export async function setPrimaryDomainAction(id: string): Promise<ActionResult> {
  const res = await run(() => setPrimaryDomain(id));
  if (res.ok) revalidatePath("/domains");
  return res as ActionResult;
}

export async function removeDomainAction(id: string): Promise<ActionResult> {
  const res = await run(() => removeDomain(id));
  if (res.ok) {
    revalidatePath("/domains");
    revalidatePath("/projects");
  }
  return res as ActionResult;
}

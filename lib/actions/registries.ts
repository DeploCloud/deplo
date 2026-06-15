"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { addRegistry, deleteRegistry } from "@/lib/data/registries";

const addSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["ghcr", "dockerhub", "gitlab", "generic"]),
  registryUrl: z.string().max(253).optional(),
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(2000),
});

export async function addRegistryAction(
  input: z.input<typeof addSchema>,
): Promise<ActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => addRegistry(parsed.data));
  if (res.ok) revalidatePath("/settings");
  return res as ActionResult;
}

export async function deleteRegistryAction(id: string): Promise<ActionResult> {
  const res = await run(() => deleteRegistry(id));
  if (res.ok) revalidatePath("/settings");
  return res as ActionResult;
}

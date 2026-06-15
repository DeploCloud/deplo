"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { addServer, removeServer } from "@/lib/data/servers";

const addSchema = z.object({
  name: z.string().min(1).max(64),
  // Hostname or IP. Reject anything with a scheme, path or whitespace.
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^[a-zA-Z0-9.-]+$/,
      "Enter a bare hostname or IP (no scheme, port or path)"
    ),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().max(64).optional(),
});

export async function addServerAction(
  input: z.input<typeof addSchema>
): Promise<ActionResult<{ id: string }>> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const res = await run(async () => {
    const server = await addServer(parsed.data);
    return { id: server.id };
  });
  if (res.ok) revalidatePath("/servers");
  return res;
}

export async function removeServerAction(id: string): Promise<ActionResult> {
  const res = await run(() => removeServer(id));
  if (res.ok) revalidatePath("/servers");
  return res as ActionResult;
}

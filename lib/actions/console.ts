"use server";

import { z } from "zod";
import { run, type ActionResult } from "./result";
import { execInContainer } from "@/lib/data/console";

const schema = z.object({
  projectId: z.string().min(1),
  command: z.string().min(1).max(2000),
});

export async function execConsoleAction(
  input: z.input<typeof schema>
): Promise<ActionResult<{ output: string; detach?: boolean }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  return run(() => execInContainer(parsed.data.projectId, parsed.data.command));
}

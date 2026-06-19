"use server";

import { z } from "zod";
import { run, type ActionResult } from "./result";
import { execInContainer, getShellLabel } from "@/lib/data/console";

const schema = z.object({
  projectId: z.string().min(1),
  command: z.string().min(1).max(2000),
  containerName: z.string().min(1).max(255).optional(),
});

export async function execConsoleAction(
  input: z.input<typeof schema>
): Promise<ActionResult<{ output: string; detach?: boolean }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  return run(() =>
    execInContainer(
      parsed.data.projectId,
      parsed.data.command,
      parsed.data.containerName
    )
  );
}

const shellSchema = z.object({
  projectId: z.string().min(1),
  containerName: z.string().min(1).max(255).optional(),
});

/**
 * Resolve the default container's shell label on demand. The console page
 * renders without blocking on the shell probe; the client calls this after
 * mount to learn whether the container is shell-less (distroless) and show the
 * raw-exec notice.
 */
export async function shellLabelAction(
  input: z.input<typeof shellSchema>
): Promise<ActionResult<{ shell: string }>> {
  const parsed = shellSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  return run(async () => ({
    shell: await getShellLabel(parsed.data.projectId, parsed.data.containerName),
  }));
}

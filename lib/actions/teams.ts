"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { updateTeam } from "@/lib/data/teams";

const schema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(60),
});

export async function updateTeamAction(
  input: z.input<typeof schema>
): Promise<ActionResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => updateTeam(parsed.data));
  if (res.ok) {
    revalidatePath("/settings");
    // Team name + plan render in the topbar on every dashboard page.
    revalidatePath("/", "layout");
  }
  return res as ActionResult;
}

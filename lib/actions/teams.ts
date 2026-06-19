"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { updateTeam, createTeam, switchTeam } from "@/lib/data/teams";
import type { Team } from "@/lib/types";

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
    // Team name renders in the topbar on every dashboard page.
    revalidatePath("/", "layout");
  }
  return res as ActionResult;
}

const createSchema = z.object({ name: z.string().min(1).max(80) });

export async function createTeamAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<Team>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => createTeam(parsed.data));
  if (res.ok) revalidatePath("/", "layout");
  return res;
}

export async function switchTeamAction(teamId: string): Promise<ActionResult> {
  const res = await run(() => switchTeam(teamId));
  // Everything in the dashboard is scoped to the active team — refresh it all.
  if (res.ok) revalidatePath("/", "layout");
  return res as ActionResult;
}

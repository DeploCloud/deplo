"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  searchUsers,
  addExistingMember,
  updateMember,
  removeMember,
  mintRegistrationLink,
  revokeRegistrationLink,
  getUserDetail,
  updateUserAdmin,
  type UserSearchResult,
  type MemberDTO,
  type MintRegistrationResult,
  type UserDetailDTO,
} from "@/lib/data/members";
import { ALL_CAPABILITIES } from "@/lib/types";

const roleSchema = z.enum(["owner", "member", "viewer"]);
const capabilitiesSchema = z
  .array(z.enum(ALL_CAPABILITIES as [string, ...string[]]))
  .optional();

/** Username-only search for users to add to the team. */
export async function searchUsersAction(
  query: string,
): Promise<ActionResult<UserSearchResult[]>> {
  if (typeof query !== "string")
    return { ok: false, error: "Invalid query" };
  return run(() => searchUsers(query.slice(0, 100)));
}

const addSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema,
  capabilities: capabilitiesSchema,
});

export async function addExistingMemberAction(
  input: z.input<typeof addSchema>,
): Promise<ActionResult<MemberDTO>> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() =>
    addExistingMember({
      userId: parsed.data.userId,
      role: parsed.data.role,
      capabilities: parsed.data.capabilities as never,
    }),
  );
  if (res.ok) revalidatePath("/members");
  return res;
}

const updateMemberSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema,
  capabilities: capabilitiesSchema,
});

export async function updateMemberAction(
  input: z.input<typeof updateMemberSchema>,
): Promise<ActionResult> {
  const parsed = updateMemberSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() =>
    updateMember({
      userId: parsed.data.userId,
      role: parsed.data.role,
      capabilities: parsed.data.capabilities as never,
    }),
  );
  if (res.ok) revalidatePath("/members");
  return res as ActionResult;
}

export async function removeMemberAction(userId: string): Promise<ActionResult> {
  const res = await run(() => removeMember(userId));
  if (res.ok) revalidatePath("/members");
  return res as ActionResult;
}

/* ------------------------------------------------------------------ */
/* Registration links (global new-account onboarding)                  */
/* ------------------------------------------------------------------ */

export async function mintRegistrationLinkAction(): Promise<
  ActionResult<MintRegistrationResult>
> {
  const res = await run(() => mintRegistrationLink());
  if (res.ok) revalidatePath("/settings");
  return res;
}

export async function revokeRegistrationLinkAction(
  id: string,
): Promise<ActionResult> {
  const res = await run(() => revokeRegistrationLink(id));
  if (res.ok) revalidatePath("/settings");
  return res as ActionResult;
}

/* ------------------------------------------------------------------ */
/* Global user administration                                          */
/* ------------------------------------------------------------------ */

/** Load full detail (incl. email) for one user — instance-admin only. */
export async function getUserDetailAction(
  userId: string,
): Promise<ActionResult<UserDetailDTO>> {
  if (typeof userId !== "string" || !userId)
    return { ok: false, error: "Invalid user" };
  return run(() => getUserDetail(userId));
}

const updateUserAdminSchema = z.object({
  userId: z.string().min(1),
  isInstanceAdmin: z.boolean(),
  suspended: z.boolean(),
  newPassword: z.string().max(200).optional(),
});

export async function updateUserAdminAction(
  input: z.input<typeof updateUserAdminSchema>,
): Promise<ActionResult> {
  const parsed = updateUserAdminSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => updateUserAdmin(parsed.data));
  if (res.ok) revalidatePath("/settings");
  return res as ActionResult;
}

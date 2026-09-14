import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq, sql } from "drizzle-orm";

import { assertUser, currentSessionId } from "../auth/current-user";
import { authHeaders } from "../auth/session-cookies";
import { markSessionAuthMethod } from "../auth/session-records";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { getDb } from "../db/client";
import { memberships, passkey as passkeyTable } from "../db/schema";
import { twoFactorMandateForCurrentUser } from "../membership";
import { passkeyRelyingParty } from "../public-url";
import { recordActivity } from "./activity";
import { stepUpPassword } from "./two-factor";

// Passkeys are USER-scoped, never team-scoped: a credential belongs to a person.

const MAX_PASSKEYS = 20;

// PasskeyKind is what holds the credential, for the row's icon and subtitle.
export type PasskeyKind = "synced" | "device" | "securityKey";

function passkeyKind(
  transports: string | null,
  backedUp: boolean,
): PasskeyKind {
  const t = (transports ?? "").toLowerCase();
  const roaming = ["usb", "nfc", "ble"].some((x) => t.includes(x));
  if (roaming && !t.includes("internal")) return "securityKey";
  return backedUp ? "synced" : "device";
}

export interface PasskeyDTO {
  id: string;
  name: string;
  createdAt: string | null;
  usableHere: boolean;
  kind: PasskeyKind;
}

// listMyPasskeys lists the passkeys on this account, newest first.
export const listMyPasskeys = cache(async (): Promise<PasskeyDTO[]> => {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const rpId = passkeyRelyingParty()?.rpId ?? null;
  const rows = await getDb()
    .select({
      id: passkeyTable.id,
      name: passkeyTable.name,
      createdAt: passkeyTable.createdAt,
      rpId: passkeyTable.rpId,
      transports: passkeyTable.transports,
      backedUp: passkeyTable.backedUp,
    })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, user.id))
    // NULLS LAST, not the Postgres default: an undated row is the oldest thing here, never the newest.
    .orderBy(sql`${passkeyTable.createdAt} desc nulls last`);
  return rows.map((r) => ({
    id: r.id,
    // The column is nullable because the library can write undefined; Deplo always sends a label.
    name: r.name?.trim() || "Passkey",
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    usableHere: rpId !== null && r.rpId === rpId,
    kind: passkeyKind(r.transports, r.backedUp),
  }));
});

// startPasskeyRegistration returns the creation options for navigator.credentials.create.
export async function startPasskeyRegistration(
  password: string,
): Promise<unknown> {
  requirePersonalSession("your passkeys");
  if (!passkeyRelyingParty())
    throw new Error(
      "Passkeys need this panel to be reachable at its own https address.",
    );
  const user = await stepUpPassword(password);
  // A ceiling, not a rate limit: the step-up limiter already bounds how fast these arrive.
  if ((await countMyPasskeys(user.id)) >= MAX_PASSKEYS)
    throw new Error(
      `This account already has ${MAX_PASSKEYS} passkeys. Remove one before adding another.`,
    );
  return requireAuth().api.generatePasskeyRegistrationOptions({
    query: {},
    headers: await authHeaders(),
  });
}

// finishPasskeyRegistration verifies the authenticator's answer and stamps the rpID the plugin never records.
export async function finishPasskeyRegistration(input: {
  response: unknown;
  name: string;
}): Promise<PasskeyDTO> {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const rpId = passkeyRelyingParty()?.rpId ?? null;
  const name = input.name.trim().slice(0, 64) || "Passkey";
  const row = await requireAuth().api.verifyPasskeyRegistration({
    body: { response: input.response, name },
    headers: await authHeaders(),
  });
  if (rpId)
    await getDb()
      .update(passkeyTable)
      .set({ rpId })
      .where(
        and(eq(passkeyTable.id, row.id), eq(passkeyTable.userId, user.id)),
      );
  const sessionId = await currentSessionId();
  if (sessionId) await markSessionAuthMethod(sessionId, user.id, "passkey");
  await announce(user.id, user.username, `Added the ${name} passkey`);
  return {
    id: row.id,
    name,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
    usableHere: rpId !== null,
    kind: passkeyKind(row.transports ?? null, row.backedUp),
  };
}

// renamePasskey relabels one passkey; the userId clause here is the gate, not a library middleware.
export async function renamePasskey(input: {
  id: string;
  name: string;
}): Promise<void> {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const name = input.name.trim().slice(0, 64);
  if (!name) throw new Error("Give this passkey a name");
  const updated = await getDb()
    .update(passkeyTable)
    .set({ name })
    .where(and(eq(passkeyTable.id, input.id), eq(passkeyTable.userId, user.id)))
    .returning({ id: passkeyTable.id });
  if (updated.length === 0)
    throw new Error("That passkey is no longer on this account.");
}

// deletePasskey removes one; count and delete share a transaction (FOR UPDATE) so two clicks cannot race.
export async function deletePasskey(input: {
  id: string;
  password: string;
}): Promise<void> {
  requirePersonalSession("your passkeys");
  const user = await stepUpPassword(input.password);
  const mandate = user.twoFactorEnabled
    ? null
    : await twoFactorMandateForCurrentUser();
  const rpId = passkeyRelyingParty()?.rpId ?? null;

  const name = await getDb().transaction(async (tx) => {
    const mine = await tx
      .select({
        id: passkeyTable.id,
        name: passkeyTable.name,
        rpId: passkeyTable.rpId,
      })
      .from(passkeyTable)
      .where(eq(passkeyTable.userId, user.id))
      .for("update");
    const target = mine.find((p) => p.id === input.id);
    if (!target) throw new Error("That passkey is no longer on this account.");
    // Only credentials that still work here count: one minted elsewhere satisfies nothing.
    const usable = mine.filter((p) => rpId !== null && p.rpId === rpId);
    const losingTheLastOne =
      usable.length <= 1 && usable.some((p) => p.id === input.id);
    if (mandate && losingTheLastOne)
      throw new Error(
        `${mandate} requires two-factor authentication. Turn on an authenticator app before removing your last passkey.`,
      );
    await tx
      .delete(passkeyTable)
      .where(
        and(eq(passkeyTable.id, input.id), eq(passkeyTable.userId, user.id)),
      );
    return target.name?.trim() || "unnamed";
  });

  await announce(user.id, user.username, `Removed the ${name} passkey`);
}

async function countMyPasskeys(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  return rows.length;
}

async function announce(
  userId: string,
  actor: string,
  message: string,
): Promise<void> {
  const rows = await getDb()
    .select({ teamId: memberships.teamId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  for (const { teamId } of rows)
    await recordActivity("security", message, actor, null, teamId);
}

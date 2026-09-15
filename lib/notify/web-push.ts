import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "../crypto";
import { assertSafeOutboundUrl } from "../outbound-url";
import { getDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { pushSubscriptions } from "../db/schema/control-plane/notifications";
import { nowIso } from "../ids";
import type { AlertMessage } from "./channels";

const SETTINGS_ID = "default";

const PUSH_TIMEOUT_MS = 5_000;

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function ensureVapidKeys(): Promise<string> {
  const db = getDb();
  const existing = await db
    .select({ publicKey: instanceSettings.vapidPublicKey })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  if (existing[0]?.publicKey) return existing[0].publicKey;

  const webpush = await import("web-push");
  const keys = webpush.generateVAPIDKeys();
  const now = nowIso();
  await db
    .insert(instanceSettings)
    .values({
      id: SETTINGS_ID,
      vapidPublicKey: keys.publicKey,
      vapidPrivateKeyEnc: encryptSecret(keys.privateKey),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: {
        vapidPublicKey: keys.publicKey,
        vapidPrivateKeyEnc: encryptSecret(keys.privateKey),
        updatedAt: now,
      },
      setWhere: isNull(instanceSettings.vapidPublicKey),
    });

  const settled = await db
    .select({ publicKey: instanceSettings.vapidPublicKey })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  return settled[0]?.publicKey ?? keys.publicKey;
}

export async function savePushSubscription(
  teamId: string,
  userId: string,
  sub: PushSubscriptionInput,
): Promise<void> {
  const row = {
    teamId,
    userId,
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    createdAt: nowIso(),
  };
  await getDb()
    .insert(pushSubscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: [
        pushSubscriptions.teamId,
        pushSubscriptions.userId,
        pushSubscriptions.endpoint,
      ],
      set: { p256dh: sub.p256dh, auth: sub.auth },
    });
}

export async function deletePushSubscription(
  teamId: string,
  userId: string,
  endpoint: string,
): Promise<void> {
  await getDb()
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.teamId, teamId),
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    );
}

export async function sendWebPushTo(
  teamId: string,
  userId: string | null,
  msg: AlertMessage,
): Promise<void> {
  const db = getDb();
  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(
      userId
        ? and(
            eq(pushSubscriptions.teamId, teamId),
            eq(pushSubscriptions.userId, userId),
          )
        : eq(pushSubscriptions.teamId, teamId),
    );
  if (subs.length === 0) {
    if (userId)
      throw new Error(
        "This browser is not registered for push notifications yet",
      );
    return;
  }

  const creds = await db
    .select({
      publicKey: instanceSettings.vapidPublicKey,
      privateKeyEnc: instanceSettings.vapidPrivateKeyEnc,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  const publicKey = creds[0]?.publicKey;
  const privateKey = creds[0]?.privateKeyEnc
    ? decryptSecret(creds[0].privateKeyEnc)
    : "";
  if (!publicKey || !privateKey)
    throw new Error("Browser push is not set up on this instance");

  const webpush = await import("web-push");
  webpush.setVapidDetails("mailto:alerts@deplo.build", publicKey, privateKey);

  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    url: msg.url,
  });
  const gone: string[] = [];
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      await assertSafeOutboundUrl(s.endpoint, "Push endpoint");
      return webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { timeout: PUSH_TIMEOUT_MS },
      );
    }),
  );
  results.forEach((r, i) => {
    if (r.status !== "rejected") return;
    const status = (r.reason as { statusCode?: number } | undefined)
      ?.statusCode;
    if (status === 404 || status === 410) gone.push(subs[i].endpoint);
  });
  if (gone.length > 0)
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.teamId, teamId),
          inArray(pushSubscriptions.endpoint, gone),
        ),
      );

  const firstError = results.find((r) => r.status === "rejected");
  if (subs.length === 1 && firstError && firstError.status === "rejected") {
    console.error("[deplo] web push failed:", firstError.reason);
    const status = (firstError.reason as { statusCode?: number } | undefined)
      ?.statusCode;
    throw new Error(
      status
        ? `The push service rejected it (${status})`
        : "The push service could not be reached",
    );
  }
}

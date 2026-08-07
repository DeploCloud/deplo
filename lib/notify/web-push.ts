import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "../crypto";
import { getDb } from "../db/client";
import {
  instanceSettings,
  pushSubscriptions,
} from "../db/schema/control-plane";
import { nowIso } from "../ids";
import type { AlertMessage } from "./channels";

/**
 * Browser push (BETA).
 *
 * The VAPID keypair identifies THIS Deplo to every browser push service, so it
 * is instance-wide — one identity per panel — and it is minted lazily the first
 * time somebody opens the notification settings. An instance that never uses
 * push never holds a key.
 *
 * A subscription belongs to a device, so it is stored per user AND per team: the
 * same person in two teams gets the alerts of both, and a browser that goes away
 * is pruned on the first 404/410 the push service answers with. That is the
 * normal end of every subscription, not an error worth surfacing.
 */

const SETTINGS_ID = "default";

/**
 * How long one push service gets. Mirrors `CHANNEL_TIMEOUT_MS` by hand rather
 * than importing it: `dispatch` → `channels` → here, so reading it from the
 * dispatcher would close a require cycle.
 */
const PUSH_TIMEOUT_MS = 5_000;

/** What a browser hands back from `pushManager.subscribe()`. */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The instance's VAPID public key, minting the pair if this is the first time.
 * Public by definition — it ships to every browser that subscribes.
 */
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
  // Guarded by `IS NULL` so two boots that race settle on one keypair — the
  // loser's read below picks up the winner's.
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

/** Record a browser's subscription for this user in this team. Idempotent. */
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
      // A browser can rotate its keys for the same endpoint.
      set: { p256dh: sub.p256dh, auth: sub.auth },
    });
}

/** Forget one browser. Scoped to the caller's own row, never anyone else's. */
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

/**
 * Push a message to a team's subscribed browsers (or one user's, when the caller
 * is testing their own device). Dead endpoints are pruned; everything else is
 * best-effort, because one browser refusing must not silence the rest.
 */
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
  // A test goes to ONE person's devices and has to say when there are none;
  // the team-wide fan-out stays silent, because a team with no subscriber is
  // not a failure.
  if (subs.length === 0) {
    if (userId)
      throw new Error("This browser is not registered for push notifications yet");
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
  // mailto: is what the push services want as a contact; the panel URL is not a
  // valid VAPID subject.
  webpush.setVapidDetails("mailto:alerts@deplo.local", publicKey, privateKey);

  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    url: msg.url,
  });
  const gone: string[] = [];
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        // web-push has no AbortSignal and no default deadline, so one endpoint
        // that accepts the connection and never answers would hold the whole
        // dispatch open. Its own socket timeout is what bounds this.
        { timeout: PUSH_TIMEOUT_MS },
      ),
    ),
  );
  results.forEach((r, i) => {
    if (r.status !== "rejected") return;
    const status = (r.reason as { statusCode?: number } | undefined)?.statusCode;
    // 404/410: the browser is gone for good. Anything else may be transient.
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

  // A test send with a single subscription should say that it failed — but only
  // that. The push endpoint is a URL the SUBSCRIBER chose, so returning the
  // remote's body or its `connect ECONNREFUSED 10.0.0.5:8443` would hand the
  // caller a read primitive against whatever they pointed it at. The status code
  // is enough to tell a dead browser from a rejected key; the rest is logged.
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

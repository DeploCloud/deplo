import "server-only";

import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";

import { ALERT_META, DEFAULT_ALERTS } from "../alerts";
import { assertUser } from "../auth/current-user";
import { decryptSecret, encryptSecret } from "../crypto";
import { getDb } from "../db/client";
import {
  notificationAlerts,
  notificationChannels,
  pushSubscriptions,
} from "../db/schema/control-plane/notifications";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import {
  CHANNEL_TIMEOUT_MS,
  sendToChannel,
  type AlertChannel,
} from "../notify/channels";
import {
  deletePushSubscription,
  ensureVapidKeys,
  savePushSubscription,
  type PushSubscriptionInput,
} from "../notify/web-push";
import { assertSafeOutboundHost, assertSafeOutboundUrl } from "../outbound-url";
import { rateLimit } from "../security";
import { ALL_ALERTS, ALL_CHANNELS } from "../types/notification";
import type {
  AlertKey,
  EmailProvider,
  NotificationChannel,
  NotificationChannelInput,
  NotificationChannelInstance,
} from "../types/notification";
import { requirePersonalSession } from "../auth/request-context";

type ChannelRow = InferSelectModel<typeof notificationChannels>;

// Scoped by team, so a cross-team id hits nothing.
async function channelRow(
  teamId: string,
  id: string,
): Promise<ChannelRow | null> {
  const rows = await getDb()
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, id),
        eq(notificationChannels.teamId, teamId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function alertsForChannels(
  ids: string[],
): Promise<Map<string, AlertKey[]>> {
  const out = new Map<string, AlertKey[]>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select({
      channelId: notificationAlerts.channelId,
      alertKey: notificationAlerts.alertKey,
      enabled: notificationAlerts.enabled,
    })
    .from(notificationAlerts)
    .where(inArray(notificationAlerts.channelId, ids));
  const decided = new Map(
    rows.map((r) => [`${r.channelId}:${r.alertKey}`, r.enabled]),
  );
  for (const id of ids)
    out.set(
      id,
      ALL_ALERTS.filter(
        (a) => decided.get(`${id}:${a}`) ?? ALERT_META[a].defaultOn,
      ),
    );
  return out;
}

// The row plus its selection, with every credential reduced to a bit.
function rowToInstance(
  row: ChannelRow,
  alerts: AlertKey[],
): NotificationChannelInstance {
  return {
    id: row.id,
    kind: row.kind as NotificationChannel,
    name: row.name,
    enabled: row.enabled,
    url: row.url,
    target: row.target,
    emailFrom: row.emailFrom,
    emailProvider: (row.emailProvider === "smtp"
      ? "smtp"
      : "resend") as EmailProvider,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpUser: row.smtpUser,
    secretSet: row.secretEnc !== "",
    secret2Set: row.secret2Enc !== "",
    alerts,
  };
}

// listNotificationChannels - the team's destinations; gated like the write, it returns real addresses.
export async function listNotificationChannels(): Promise<
  NotificationChannelInstance[]
> {
  await requireTeamWide("notification channels");
  const { teamId } = await requireCapability("manage_notifications");
  const rows = await getDb()
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.teamId, teamId))
    .orderBy(asc(notificationChannels.createdAt));
  const alerts = await alertsForChannels(rows.map((r) => r.id));
  return rows.map((r) =>
    rowToInstance(r, alerts.get(r.id) ?? [...DEFAULT_ALERTS]),
  );
}

const bool = (v: unknown): boolean => v === true;
// Capped: an uncapped JSON scalar is a free row-size multiplier for anyone who can save.
const MAX_FIELD = 512;
const str = (v: unknown): string =>
  typeof v === "string" ? v.trim().slice(0, MAX_FIELD) : "";
const port = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 587;
};

// parseChannelInput - coerce the JSON scalar into one real channel; an unknown kind is refused.
export function parseChannelInput(raw: unknown): NotificationChannelInput {
  const i = (raw ?? {}) as Partial<NotificationChannelInput>;
  const kind = str(i.kind) as NotificationChannel;
  if (!ALL_CHANNELS.includes(kind)) throw new Error("Unknown channel type");
  const wanted = new Set(
    Array.isArray(i.alerts) ? (i.alerts as unknown[]) : [],
  );
  const secrets = (i.secrets ?? {}) as NonNullable<
    NotificationChannelInput["secrets"]
  >;
  return {
    kind,
    name: str(i.name),
    enabled: bool(i.enabled),
    url: str(i.url) || (kind === "ntfy" ? "https://ntfy.sh" : ""),
    target: str(i.target),
    emailFrom: str(i.emailFrom),
    emailProvider: i.emailProvider === "smtp" ? "smtp" : "resend",
    smtpHost: str(i.smtpHost),
    smtpPort: port(i.smtpPort),
    smtpUser: str(i.smtpUser),
    alerts: ALL_ALERTS.filter((a) => wanted.has(a)),
    secrets: { secret: str(secrets.secret), secret2: str(secrets.secret2) },
  };
}

const URL_LABEL: Partial<Record<NotificationChannel, string>> = {
  discord: "Discord webhook URL",
  slack: "Slack webhook URL",
  webhook: "Webhook URL",
  lark: "Lark webhook URL",
  msteams: "Microsoft Teams webhook URL",
  mattermost: "Mattermost webhook URL",
  gotify: "Gotify server URL",
  ntfy: "ntfy server URL",
};

// saveNotificationChannel - create (id === null) or replace one channel, returning what was saved.
export async function saveNotificationChannel(
  id: string | null,
  raw: unknown,
): Promise<NotificationChannelInstance> {
  const teamId = (await requireCapability("manage_notifications")).teamId;
  const next = parseChannelInput(raw);

  // SSRF guard: the control plane dials these from a background loop with nobody behind it.
  const label = URL_LABEL[next.kind];
  if (label && next.url) await assertSafeOutboundUrl(next.url, label);
  // SMTP is a bare host rather than a URL, so it takes the HOST form of the same guard.
  if (next.kind === "email" && next.emailProvider === "smtp" && next.smtpHost)
    await assertSafeOutboundHost(next.smtpHost, "SMTP host");

  // Read before the transaction: a query on its own connection inside one deadlocks pglite.
  const prev = id ? await channelRow(teamId, id) : null;
  if (id && !prev) throw new Error("Channel not found");
  if (!prev) await assertRoomForOneMore(teamId);

  // A stored credential is kept only while the destination it was typed for is the same one.
  if (
    prev &&
    prev.secretEnc &&
    !next.secrets?.secret &&
    (next.url !== prev.url || next.smtpHost !== prev.smtpHost)
  )
    throw new Error(
      "The address changed, so enter this channel's token or password again",
    );
  const keep = (fresh: string | undefined, stored: string | undefined) =>
    fresh ? encryptSecret(fresh) : (stored ?? "");

  const row: ChannelRow = {
    id: prev?.id ?? newId("chan"),
    teamId,
    // Frozen at create: a changed kind would carry a selection made about something else.
    kind: prev?.kind ?? next.kind,
    name: next.name,
    enabled: next.enabled,
    url: next.url,
    target: next.target,
    secretEnc: keep(next.secrets?.secret, prev?.secretEnc),
    secret2Enc: keep(next.secrets?.secret2, prev?.secret2Enc),
    emailFrom: next.emailFrom,
    emailProvider: next.emailProvider,
    smtpHost: next.smtpHost,
    smtpPort: next.smtpPort,
    smtpUser: next.smtpUser,
    createdAt: prev?.createdAt ?? nowIso(),
  };

  await getDb().transaction(async (tx) => {
    await tx
      .insert(notificationChannels)
      .values(row)
      .onConflictDoUpdate({ target: notificationChannels.id, set: row });
    await tx
      .delete(notificationAlerts)
      .where(eq(notificationAlerts.channelId, row.id));
    await tx.insert(notificationAlerts).values(
      ALL_ALERTS.map((a) => ({
        channelId: row.id,
        alertKey: a,
        enabled: next.alerts.includes(a),
      })),
    );
  });

  return rowToInstance(row, [...next.alerts]);
}

const MAX_CHANNELS_PER_TEAM = 25;

async function assertRoomForOneMore(teamId: string): Promise<void> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(notificationChannels)
    .where(eq(notificationChannels.teamId, teamId));
  if (Number(row?.n ?? 0) >= MAX_CHANNELS_PER_TEAM)
    throw new Error(
      `A team can have ${MAX_CHANNELS_PER_TEAM} channels. Remove one to add another.`,
    );
}

// deleteNotificationChannel - forget one channel; its alert rows go with it, by FK cascade.
export async function deleteNotificationChannel(id: string): Promise<void> {
  const teamId = (await requireCapability("manage_notifications")).teamId;
  const gone = await getDb()
    .delete(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, id),
        eq(notificationChannels.teamId, teamId),
      ),
    )
    .returning({ id: notificationChannels.id });
  if (gone.length === 0) throw new Error("Channel not found");
}

function channelFor(row: ChannelRow, userId?: string): AlertChannel | string {
  // Validated against ALL_CHANNELS on the way in (parseChannelInput).
  const kind = row.kind as NotificationChannel;
  switch (kind) {
    case "discord":
      return row.url
        ? { kind: "discord", webhookUrl: row.url }
        : "Add a Discord webhook URL first";
    case "slack":
      return row.url
        ? { kind: "slack", webhookUrl: row.url }
        : "Add a Slack webhook URL first";
    case "webhook":
      return row.url
        ? { kind: "webhook", url: row.url }
        : "Add a webhook URL first";
    case "lark":
      return row.url
        ? { kind: "lark", webhookUrl: row.url }
        : "Add a Lark webhook URL first";
    case "msteams":
      return row.url
        ? { kind: "msteams", webhookUrl: row.url }
        : "Add a Microsoft Teams webhook URL first";
    case "mattermost":
      return row.url
        ? { kind: "mattermost", webhookUrl: row.url }
        : "Add a Mattermost webhook URL first";
    case "telegram":
      return row.target && row.secretEnc
        ? {
            kind: "telegram",
            botToken: decryptSecret(row.secretEnc),
            chatId: row.target,
          }
        : "Add a Telegram bot token and chat id first";
    case "gotify":
      return row.url && row.secretEnc
        ? { kind: "gotify", url: row.url, token: decryptSecret(row.secretEnc) }
        : "Add a Gotify server URL and app token first";
    case "ntfy":
      return row.url && row.target
        ? {
            kind: "ntfy",
            baseUrl: row.url,
            topic: row.target,
            token: row.secretEnc ? decryptSecret(row.secretEnc) : "",
          }
        : "Add an ntfy server URL and topic first";
    case "pushover":
      return row.secretEnc && row.secret2Enc
        ? {
            kind: "pushover",
            token: decryptSecret(row.secretEnc),
            userKey: decryptSecret(row.secret2Enc),
          }
        : "Add a Pushover application token and user key first";
    case "email":
      return emailChannelFor(row);
    case "push":
      return { kind: "push", teamId: row.teamId, userId };
    default: {
      // The never makes a NEW kind a compile error; the return handles a retired one.
      const unreachable: never = kind;
      return `Unknown channel type ${String(unreachable)}`;
    }
  }
}

function emailChannelFor(row: ChannelRow): AlertChannel | string {
  if (!row.target) return "Add an email address first";
  const from = row.emailFrom || row.target;
  if (row.emailProvider === "resend") {
    if (!row.secret2Enc) return "Add a Resend API key first";
    return {
      kind: "email",
      to: row.target,
      config: {
        provider: "resend",
        apiKey: decryptSecret(row.secret2Enc),
        from,
      },
    };
  }
  if (!row.smtpHost) return "Add an SMTP host first";
  return {
    kind: "email",
    to: row.target,
    config: {
      provider: "smtp",
      host: row.smtpHost,
      port: row.smtpPort,
      user: row.smtpUser,
      password: row.secretEnc ? decryptSecret(row.secretEnc) : "",
      from,
    },
  };
}

// channelsForAlert - the channels that want this alert; returns plaintext credentials, never a DTO.
export async function channelsForAlert(
  teamId: string,
  key: AlertKey,
): Promise<AlertChannel[]> {
  const rows = await getDb()
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.teamId, teamId),
        eq(notificationChannels.enabled, true),
      ),
    );
  if (rows.length === 0) return [];
  const decided = new Map(
    (
      await getDb()
        .select({
          channelId: notificationAlerts.channelId,
          enabled: notificationAlerts.enabled,
        })
        .from(notificationAlerts)
        .where(
          and(
            inArray(
              notificationAlerts.channelId,
              rows.map((r) => r.id),
            ),
            eq(notificationAlerts.alertKey, key),
          ),
        )
    ).map((r) => [r.channelId, r.enabled] as const),
  );
  const fallback = ALERT_META[key].defaultOn;
  return rows
    .filter((r) => decided.get(r.id) ?? fallback)
    .map((r) => channelFor(r))
    .filter((c): c is AlertChannel => typeof c !== "string");
}

// sendTestNotification - one test alert through one channel; browser push goes to the caller's devices.
export async function sendTestNotification(channelId: string): Promise<void> {
  // A real outbound POST, so it takes the write's gate: view-only cannot drive traffic.
  const { teamId, userId } = await requireCapability("manage_notifications");
  // One press is one outbound request to an address the presser chose, so it is counted.
  if (
    !(await rateLimit(`notify-test:${userId}`, { limit: 10, windowMs: 60_000 }))
      .ok
  )
    throw new Error("Too many test alerts. Wait a minute and try again.");
  const row = await channelRow(teamId, channelId);
  if (!row) throw new Error("Channel not found");
  const target = channelFor(row, userId);
  if (typeof target === "string") throw new Error(target);
  try {
    await sendToChannel(
      target,
      {
        // A success key on purpose: the Discord embed colours itself from the key.
        key: "deployment_succeeded",
        title: "Deplo test alert",
        body: "This channel is wired up correctly.",
        url: null,
        ts: new Date().toISOString(),
      },
      AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
    );
  } catch (e) {
    throw new Error(deliveryReason(e));
  }
}

// deliveryReason - why a send failed; fetch says only "fetch failed" and hides the rest on cause.
export function deliveryReason(e: unknown): string {
  const seen: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = (cur as NodeJS.ErrnoException).code;
    for (const part of [cur.message, code])
      if (part && !seen.includes(part)) seen.push(part);
    cur = (cur as { cause?: unknown }).cause;
  }
  return seen.join(" - ") || "The channel could not be reached";
}

// getWebPushPublicKey - the instance's VAPID public key, minted on first use. Public by design.
export async function getWebPushPublicKey(): Promise<string> {
  await assertUser();
  return ensureVapidKeys();
}

// subscribeWebPush - opt this browser in; the endpoint is caller-supplied, so it takes the URL guard.
export async function subscribeWebPush(
  sub: PushSubscriptionInput,
): Promise<void> {
  requirePersonalSession("push notifications");
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  if (!sub.endpoint || !sub.p256dh || !sub.auth)
    throw new Error("The browser did not return a usable subscription");
  await assertSafeOutboundUrl(sub.endpoint, "Push endpoint");
  await assertRoomForOneMoreDevice(teamId, user.id, sub.endpoint);
  await savePushSubscription(teamId, user.id, sub);
}

const MAX_DEVICES_PER_USER = 10;

async function assertRoomForOneMoreDevice(
  teamId: string,
  userId: string,
  endpoint: string,
): Promise<void> {
  // Counts the OTHER devices: the save is an upsert, so a key rotation must not hit the cap.
  const [row] = await getDb()
    .select({ n: count() })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.teamId, teamId),
        eq(pushSubscriptions.userId, userId),
        ne(pushSubscriptions.endpoint, endpoint),
      ),
    );
  if (Number(row?.n ?? 0) >= MAX_DEVICES_PER_USER)
    throw new Error(
      `You can register ${MAX_DEVICES_PER_USER} browsers for push notifications.`,
    );
}

// unsubscribeWebPush - opt this browser back out, scoped to the caller's own row.
export async function unsubscribeWebPush(endpoint: string): Promise<void> {
  requirePersonalSession("push notifications");
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  await deletePushSubscription(teamId, user.id, endpoint);
}

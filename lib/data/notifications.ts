import "server-only";

import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";

import { ALERT_META, DEFAULT_ALERTS } from "../alerts";
import { assertUser } from "../auth";
import { decryptSecret, encryptSecret } from "../crypto";
import { getDb } from "../db/client";
import {
  notificationAlerts,
  notificationChannels,
  pushSubscriptions,
} from "../db/schema/control-plane";
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
import { ALL_ALERTS, ALL_CHANNELS } from "../types";
import type {
  AlertKey,
  EmailProvider,
  NotificationChannel,
  NotificationChannelInput,
  NotificationChannelInstance,
} from "../types";

/**
 * Notification channels: N configured destinations per team, any kind
 * repeatable, each with its own alert selection.
 *
 * Two storage rules carry the whole feature. A CHANNEL is one flat row
 * (`notification_channels`), because a channel is a fixed set of named
 * heterogeneous fields. Its subscribed ALERTS are a list, so they live one level
 * down in `notification_alerts` keyed on the instance — where an ABSENT row
 * means "never decided" and falls back to `ALERT_META[key].defaultOn`. That one
 * fallback does double duty: a new alert key ships with no backfill, and a
 * brand-new channel starts on the catalog defaults with nothing written.
 */

type ChannelRow = InferSelectModel<typeof notificationChannels>;

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** One channel of this team, or null. Scoped so a cross-team id hits nothing. */
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

/**
 * What each of these channels is subscribed to. A `(channel, key)` with no row
 * has never been decided about, so it falls back to the catalog default — which
 * is what makes a brand-new channel start on `DEFAULT_ALERTS` with nothing
 * seeded, and what lets a new alert key reach every channel with no backfill.
 */
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

/** The row plus its selection, with every credential reduced to a bit. */
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

/**
 * Every configured destination of the active team, oldest first.
 *
 * Gated on `manage_notifications` and not on the `view` floor, because a channel
 * row IS a credential: a Discord/Slack/Teams/Mattermost/Lark webhook URL is a
 * bearer token in URL form, and anybody holding one can post into the team's
 * room as Deplo. There is no masked variant to fall back to — the edit modal
 * needs the real address — so the read carries the same gate as the write.
 */
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

/* ------------------------------------------------------------------ */
/* The JSON trust boundary                                             */
/* ------------------------------------------------------------------ */

const bool = (v: unknown): boolean => v === true;
/**
 * A stored field is text a human typed, so it is capped: nothing here is a
 * document, and an uncapped `JSON` scalar is a free row-size multiplier for
 * anybody who can save a channel.
 */
const MAX_FIELD = 512;
const str = (v: unknown): string =>
  typeof v === "string" ? v.trim().slice(0, MAX_FIELD) : "";
const port = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 587;
};

/**
 * Coerce whatever arrived over the `JSON` scalar into one real channel.
 *
 * The mutation's argument is an opaque scalar, so anything at all can be sent —
 * this is a trust boundary, and every field is defaulted rather than trusted.
 * Unknown alert keys are dropped BY CONSTRUCTION, not by a validation step
 * somebody could skip: the list is built by filtering `ALL_ALERTS`, never by
 * reading the input's own array.
 *
 * The `kind` is the one thing that THROWS rather than coercing. A save is for
 * one instance, so silently turning an unknown kind into a Discord would create
 * a channel nobody asked for.
 */
export function parseChannelInput(raw: unknown): NotificationChannelInput {
  const i = (raw ?? {}) as Partial<NotificationChannelInput>;
  const kind = str(i.kind) as NotificationChannel;
  if (!ALL_CHANNELS.includes(kind)) throw new Error("Unknown channel type");
  const wanted = new Set(Array.isArray(i.alerts) ? (i.alerts as unknown[]) : []);
  const secrets = (i.secrets ?? {}) as NonNullable<
    NotificationChannelInput["secrets"]
  >;
  return {
    kind,
    name: str(i.name),
    enabled: bool(i.enabled),
    // ntfy is the one kind with a meaningful default address.
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

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** What the outbound guard calls each kind's URL when it refuses one. */
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

/**
 * Create (`id === null`) or replace one channel. Returns what was saved.
 *
 * One function rather than create + update: they differ by four lines, and the
 * UI has one modal that serves both.
 */
export async function saveNotificationChannel(
  id: string | null,
  raw: unknown,
): Promise<NotificationChannelInstance> {
  const teamId = (await requireCapability("manage_notifications")).teamId;
  const next = parseChannelInput(raw);

  // Dialed FROM the control plane by a background loop with no user behind it,
  // so reject private/internal targets before they are ever persisted. Checked
  // again at the dial in `sendToChannel`: a row can predate the guard, and a 302
  // is the other way out of a checked URL.
  const label = URL_LABEL[next.kind];
  if (label && next.url) await assertSafeOutboundUrl(next.url, label);
  // SMTP is a bare host rather than a URL, so it takes the HOST form of the same
  // guard. Without it, `email` would be the one channel kind that can dial the
  // control plane's own network.
  if (next.kind === "email" && next.emailProvider === "smtp" && next.smtpHost)
    await assertSafeOutboundHost(next.smtpHost, "SMTP host");

  // Read the stored ciphertext BEFORE the transaction (a query on its own
  // connection inside one deadlocks the test harness) — an empty secret means
  // "keep the stored one", so an edit that only moves the channel's NAME must
  // not require retyping the password.
  const prev = id ? await channelRow(teamId, id) : null;
  if (id && !prev) throw new Error("Channel not found");
  if (!prev) await assertRoomForOneMore(teamId);

  // A stored credential is kept only while the destination it was typed for is
  // the same one. Editing just the URL or the SMTP host, leaving the secret
  // blank, would otherwise FORWARD the stored token to whoever owns the new
  // address — a `manage_notifications` holder who cannot read the secret can
  // still have it delivered to a host they control (Gotify's `X-Gotify-Key`,
  // ntfy's bearer, the SMTP AUTH password). So the save is refused instead.
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
    // FROZEN at create: an instance that changed kind would carry an alert
    // selection made about something else entirely.
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
    // The modal always posts the whole set for THIS channel, so replace it
    // wholesale: that also retires keys the catalog dropped, with no cleanup.
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

/**
 * How many destinations one team may configure.
 *
 * Every alert fans out to all of them, so an unbounded list is an unbounded
 * outbound multiplier on one team's say-so. Well past what a real team wires up
 * (two rooms, an inbox and a webhook is a busy team) and low enough that the
 * fan-out stays a handful of POSTs.
 */
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

/** Forget one channel. Its alert rows go with it, by FK cascade. */
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

/* ------------------------------------------------------------------ */
/* The dial                                                            */
/* ------------------------------------------------------------------ */

/**
 * The dial for ONE channel, or the message the user needs to finish setting it
 * up. The dispatcher drops the strings; the Test button throws them. ONE switch,
 * so "configured enough to send" is defined exactly once and two copies of it
 * can never drift apart.
 *
 * `userId` is only for browser push: a test goes to the CALLER's own devices, a
 * real alert to the whole team's.
 */
function channelFor(row: ChannelRow, userId?: string): AlertChannel | string {
  // Validated against ALL_CHANNELS on the way in (`parseChannelInput`).
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
            // A public topic needs no token, so an empty one is a valid config.
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
      // A kind the catalog retired would otherwise be a silent no-op — the exact
      // bug this feature exists to close. The `never` makes forgetting a NEW
      // kind a compile error; the return handles a stale row.
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
      config: { provider: "resend", apiKey: decryptSecret(row.secret2Enc), from },
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

/**
 * The configured channels that want `key`, resolved WITHOUT a request.
 *
 * Deliberately ungated and `teamId`-by-parameter, like `recordServerHealth` and
 * `executeBackup`: most alerts are raised by a deploy runner, a scheduler tick
 * or a telemetry stream, none of which has an active team or a user. It is
 * INTERNAL — never exported through GraphQL, never called from a resolver;
 * `listNotificationChannels()` stays the only request-facing read, with both
 * gates on it.
 *
 * The alert filter runs on the ROW, before it becomes an `AlertChannel`: the
 * decision belongs to the INSTANCE, and two Discord rooms with different
 * selections are the whole point. Filtering after the flattening would have to
 * key on `kind`, which is the same answer for both of them.
 *
 * Returns plaintext credentials, so it must never reach a DTO.
 */
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
  // No row for `key` means this channel has never decided about it.
  const fallback = ALERT_META[key].defaultOn;
  return rows
    .filter((r) => decided.get(r.id) ?? fallback)
    .map((r) => channelFor(r))
    .filter((c): c is AlertChannel => typeof c !== "string");
}

/* ------------------------------------------------------------------ */
/* Test sends and browser push                                         */
/* ------------------------------------------------------------------ */

/**
 * Deliver a one-off test alert through ONE channel, using its saved config.
 * Browser push goes to the CALLER's own devices.
 */
export async function sendTestNotification(channelId: string): Promise<void> {
  // Sending a real outbound POST is a side-effecting infra action — gate it the
  // same way as editing, so a view-only member can't drive traffic to the team's
  // configured endpoints.
  const { teamId, userId } = await requireCapability("manage_notifications");
  // One button press is one outbound request to an address the presser chose, so
  // it is counted like every other sensitive action. Without this the settings
  // page is a request generator anybody with the capability can hold down.
  if (!rateLimit(`notify-test:${userId}`, { limit: 10, windowMs: 60_000 }).ok)
    throw new Error("Too many test alerts. Wait a minute and try again.");
  const row = await channelRow(teamId, channelId);
  if (!row) throw new Error("Channel not found");
  const target = channelFor(row, userId);
  if (typeof target === "string") throw new Error(target);
  // The same deadline the dispatcher gives a channel: a settings-page mutation
  // must not hang on a destination that accepts the connection and goes quiet.
  await sendToChannel(
    target,
    {
      key: "deployment_failed",
      title: "Deplo test alert",
      body: "This channel is wired up correctly.",
      url: null,
      ts: new Date().toISOString(),
    },
    AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
  );
}

/** The instance's VAPID public key, minted on first use. Public by design. */
export async function getWebPushPublicKey(): Promise<string> {
  await assertUser();
  return ensureVapidKeys();
}

/**
 * Opt this browser in. Gated on being a member of the active team, NOT on
 * `manage_notifications`: subscribing your own device is your own business, the
 * same way revoking your own session is.
 *
 * The endpoint is a URL the CALLER supplies and the control plane later dials
 * from a background loop with nobody behind it — the same shape as a webhook,
 * and so it takes the same guard. Skipping it made this the one place where the
 * lowest privilege in the product could aim a control-plane request at the
 * inside of its own network.
 */
export async function subscribeWebPush(
  sub: PushSubscriptionInput,
): Promise<void> {
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  if (!sub.endpoint || !sub.p256dh || !sub.auth)
    throw new Error("The browser did not return a usable subscription");
  await assertSafeOutboundUrl(sub.endpoint, "Push endpoint");
  await assertRoomForOneMoreDevice(teamId, user.id, sub.endpoint);
  await savePushSubscription(teamId, user.id, sub);
}

/**
 * How many browsers one person may register per team. Every team alert POSTs to
 * each of them, so this is the per-member half of the same fan-out bound
 * {@link MAX_CHANNELS_PER_TEAM} puts on the team. Nobody carries ten devices; a
 * list that grows past this is a list being used for something else.
 */
const MAX_DEVICES_PER_USER = 10;

async function assertRoomForOneMoreDevice(
  teamId: string,
  userId: string,
  endpoint: string,
): Promise<void> {
  // Counts the OTHER devices: the save is an upsert, so a browser rotating its
  // keys on an endpoint it already holds must not be refused at the cap.
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

/** Opt this browser back out. Scoped to the caller's own row. */
export async function unsubscribeWebPush(endpoint: string): Promise<void> {
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  await deletePushSubscription(teamId, user.id, endpoint);
}

import "server-only";

import { randomUUID } from "node:crypto";

import { createPubSub } from "@graphql-yoga/subscription";
import { Client } from "pg";

import { databaseUrl, getPool, isPostgresEnabled, isTestEnv } from "../db/pg";

/**
 * In-process publish/subscribe used to push live updates to GraphQL subscribers
 * over SSE.
 */
type Channels = {
  appChanged: [id: string, payload: string];
  appActivity: [topic: string, payload: string];
  migrationActivity: [topic: string, payload: string];
  databaseChanged: [id: string, payload: string];
  cleanupRunsChanged: [id: string, payload: string];
};
type ServicePubSub = ReturnType<typeof createPubSub<Channels>>;

const PUBSUB_KEY = Symbol.for("deplo.graphql.pubsub.singleton");
const g = globalThis as unknown as { [PUBSUB_KEY]?: ServicePubSub };

export const pubSub: ServicePubSub = (g[PUBSUB_KEY] ??=
  createPubSub<Channels>());

/**
 * The one key the `appActivity` channel uses. A team-wide feed - "is anything
 * deploying right now" - has no per-resource key to filter on, so it rides a
 * single channel with a constant key, the same shape as {@link CLEANUP_RUNS_TOPIC}.
 */
export const APP_ACTIVITY_TOPIC = "instance";

/** Notify every subscriber that this app's state changed. */
export function publishAppChanged(appId: string): void {
  emit("appChanged", appId, appId);
  // ponytail: one instance-wide channel, so every open sidebar re-counts on any
  // app change (a COUNT over the team's in-flight builds). Key it per team if
  // the wakeups ever show up in a profile.
  emit("appActivity", APP_ACTIVITY_TOPIC, appId);
}

/**
 * The one key the `migrationActivity` channel uses, for the same reason as
 * {@link APP_ACTIVITY_TOPIC}: "is a migration running in my team" is a
 * team-wide question, and each subscriber answers it for its own team.
 */
export const MIGRATION_ACTIVITY_TOPIC = "instance";

/** Notify every subscriber that a migration started, moved on, or ended. */
export function publishMigrationChanged(): void {
  emit("migrationActivity", MIGRATION_ACTIVITY_TOPIC, MIGRATION_ACTIVITY_TOPIC);
}

/** Notify every subscriber that this database's state changed — same contract
 *  as {@link publishAppChanged}: the payload is just the id, "re-read it". */
export function publishDatabaseChanged(databaseId: string): void {
  emit("databaseChanged", databaseId, databaseId);
}

/**
 * The one key the `cleanupRunsChanged` channel uses.
 */
export const CLEANUP_RUNS_TOPIC = "instance";

/** Notify every subscriber that the Docker cleanup history changed — a sweep
 *  started, finished, or was pruned. Payload-free in spirit (the key is a
 *  constant): "re-read the runs". */
export function publishCleanupRunsChanged(): void {
  emit("cleanupRunsChanged", CLEANUP_RUNS_TOPIC, CLEANUP_RUNS_TOPIC);
}

/* ------------------------------------------------------------------ */
/* Cross-process bridge (Postgres LISTEN/NOTIFY)                       */
/* ------------------------------------------------------------------ */

/**
 * The emitter above is per PROCESS, and for a long time that was the whole story:
 * one `next start`, one emitter, every publish reaching every SSE stream on the
 * instance.
 */
const NOTIFY_CHANNEL = "deplo_pubsub";

/** This process, so the notification we sent is not replayed back into it. */
export const PUBSUB_INSTANCE = `${process.pid}-${randomUUID()}`;

/** The channels a peer may publish into, as a runtime set (types are erased). */
const CHANNELS: readonly (keyof Channels)[] = [
  "appChanged",
  "appActivity",
  "migrationActivity",
  "databaseChanged",
  "cleanupRunsChanged",
];

interface RemoteMessage {
  /** The sending instance. */
  i: string;
  c: keyof Channels;
  k: string;
  p: string;
}

/**
 * Read a peer's notification, or `null` for anything not to be republished: our
 * own echo, a channel this version does not know, or a payload that is not one of
 * ours at all (the channel name is a plain string - somebody else's `NOTIFY` can
 */
export function decodeRemote(raw: string): RemoteMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const { i, c, k, p } = m as Record<string, unknown>;
  if (typeof i !== "string" || i === PUBSUB_INSTANCE) return null;
  if (typeof c !== "string" || !CHANNELS.includes(c as keyof Channels))
    return null;
  if (typeof k !== "string" || typeof p !== "string") return null;
  return { i, c: c as keyof Channels, k, p };
}

/** Publish locally AND to every other control plane on this database. */
function emit(channel: keyof Channels, key: string, payload: string): void {
  pubSub.publish(channel, key, payload);
  if (!bridgeEnabled()) return;
  // Fire-and-forget: a live view is a decoration, and a database hiccup must
  // never fail the mutation that was only announcing itself.
  void getPool()
    .query("select pg_notify($1, $2)", [
      NOTIFY_CHANNEL,
      JSON.stringify({ i: PUBSUB_INSTANCE, c: channel, k: key, p: payload }),
    ])
    .catch((e: unknown) => {
      console.warn(
        `[deplo] live-update notify failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
}

function bridgeEnabled(): boolean {
  return isPostgresEnabled() && !isTestEnv();
}

/** Same globalThis rationale as the emitter itself: two module registries in
 *  `next dev` would otherwise open two listeners and deliver everything twice. */
interface BridgeState {
  client: Client | null;
  retry: ReturnType<typeof setTimeout> | null;
}
const BRIDGE_KEY = Symbol.for("deplo.graphql.pubsub.bridge");
const gb = globalThis as unknown as { [BRIDGE_KEY]?: BridgeState };
const bridge: BridgeState = (gb[BRIDGE_KEY] ??= { client: null, retry: null });

/**
 * Start listening for the other control planes.
 */
export function startPubSubBridge(): void {
  if (!bridgeEnabled() || bridge.client || bridge.retry) return;
  const client = new Client({
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 10_000,
  });
  bridge.client = client;
  client.on("notification", (msg) => {
    if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
    const m = decodeRemote(msg.payload);
    if (m) pubSub.publish(m.c, m.k, m.p);
  });
  client.on("error", (e: unknown) => {
    console.warn(
      `[deplo] live-update bridge lost: ${e instanceof Error ? e.message : String(e)}`,
    );
    reconnect(client);
  });
  client.on("end", () => reconnect(client));
  client
    .connect()
    .then(() => client.query(`LISTEN ${NOTIFY_CHANNEL}`))
    .then(() => console.log("[deplo] live-update bridge listening"))
    .catch((e: unknown) => {
      console.warn(
        `[deplo] live-update bridge could not start: ${e instanceof Error ? e.message : String(e)}`,
      );
      reconnect(client);
    });
}

function reconnect(client: Client): void {
  // Whoever gets here first owns the reconnect: `error` is routinely followed
  // by `end` for the same socket.
  if (bridge.client !== client) return;
  bridge.client = null;
  void client.end().catch(() => {});
  bridge.retry = setTimeout(() => {
    bridge.retry = null;
    startPubSubBridge();
  }, 3000);
  bridge.retry.unref?.();
}

/** Hand the connection back on a clean shutdown. */
export async function stopPubSubBridge(): Promise<void> {
  if (bridge.retry) clearTimeout(bridge.retry);
  bridge.retry = null;
  const client = bridge.client;
  bridge.client = null;
  if (client) await client.end().catch(() => {});
}

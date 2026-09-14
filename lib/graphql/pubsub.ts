import "server-only";

import { randomUUID } from "node:crypto";

import { createPubSub } from "@graphql-yoga/subscription";
import { Client } from "pg";

import { databaseUrl, getPool, isPostgresEnabled, isTestEnv } from "../db/pg";

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

// APP_ACTIVITY_TOPIC is the constant key of the team-wide `appActivity` channel.
export const APP_ACTIVITY_TOPIC = "instance";

// publishAppChanged notifies every subscriber that this app's state changed.
export function publishAppChanged(appId: string): void {
  emit("appChanged", appId, appId);
  // ponytail: one instance-wide channel, so every open sidebar re-counts on any
  // app change (a COUNT over the team's in-flight builds). Key it per team if
  // the wakeups ever show up in a profile.
  emit("appActivity", APP_ACTIVITY_TOPIC, appId);
}

// MIGRATION_ACTIVITY_TOPIC is the constant key of the `migrationActivity` channel.
export const MIGRATION_ACTIVITY_TOPIC = "instance";

// publishMigrationChanged notifies every subscriber that a migration moved on.
export function publishMigrationChanged(): void {
  emit("migrationActivity", MIGRATION_ACTIVITY_TOPIC, MIGRATION_ACTIVITY_TOPIC);
}

// publishDatabaseChanged notifies every subscriber that this database's state changed.
export function publishDatabaseChanged(databaseId: string): void {
  emit("databaseChanged", databaseId, databaseId);
}

// CLEANUP_RUNS_TOPIC is the constant key of the `cleanupRunsChanged` channel.
export const CLEANUP_RUNS_TOPIC = "instance";

// publishCleanupRunsChanged notifies every subscriber that the cleanup history changed.
export function publishCleanupRunsChanged(): void {
  emit("cleanupRunsChanged", CLEANUP_RUNS_TOPIC, CLEANUP_RUNS_TOPIC);
}

const NOTIFY_CHANNEL = "deplo_pubsub";

// PUBSUB_INSTANCE is this process, so a notification we sent is not replayed into it.
export const PUBSUB_INSTANCE = `${process.pid}-${randomUUID()}`;

const CHANNELS: readonly (keyof Channels)[] = [
  "appChanged",
  "appActivity",
  "migrationActivity",
  "databaseChanged",
  "cleanupRunsChanged",
];

interface RemoteMessage {
  i: string;
  c: keyof Channels;
  k: string;
  p: string;
}

// decodeRemote reads a peer's notification, or null for our own echo or a foreign NOTIFY.
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

function emit(channel: keyof Channels, key: string, payload: string): void {
  pubSub.publish(channel, key, payload);
  if (!bridgeEnabled()) return;
  // Fire-and-forget: a database hiccup must never fail the mutation announcing itself.
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

// Two module registries in `next dev` would otherwise listen twice and deliver twice.
interface BridgeState {
  client: Client | null;
  retry: ReturnType<typeof setTimeout> | null;
}
const BRIDGE_KEY = Symbol.for("deplo.graphql.pubsub.bridge");
const gb = globalThis as unknown as { [BRIDGE_KEY]?: BridgeState };
const bridge: BridgeState = (gb[BRIDGE_KEY] ??= { client: null, retry: null });

// startPubSubBridge starts listening for the other control planes.
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
  // Whoever gets here first owns the reconnect: `error` is routinely followed by `end`.
  if (bridge.client !== client) return;
  bridge.client = null;
  void client.end().catch(() => {});
  bridge.retry = setTimeout(() => {
    bridge.retry = null;
    startPubSubBridge();
  }, 3000);
  bridge.retry.unref?.();
}

// stopPubSubBridge hands the connection back on a clean shutdown.
export async function stopPubSubBridge(): Promise<void> {
  if (bridge.retry) clearTimeout(bridge.retry);
  bridge.retry = null;
  const client = bridge.client;
  bridge.client = null;
  if (client) await client.end().catch(() => {});
}

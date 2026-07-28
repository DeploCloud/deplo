import "server-only";

import { createPubSub } from "@graphql-yoga/subscription";

/**
 * In-process publish/subscribe used to push live updates to GraphQL
 * subscribers over SSE. One logical channel per project, keyed by project id:
 *
 *   pubSub.publish("appChanged", appId, appId)  // an app changed
 *   pubSub.subscribe("appChanged", appId)           // pings for that id
 *
 * The payload is just the app id — a publish means "this app changed,
 * re-read it". The subscription resolver reloads the app from the store and
 * emits the fresh snapshot, so subscribers never receive (and we never have to
 * serialize) a partial diff. The keyed form `[id, payload]` is what lets
 * `subscribe(topic, id)` filter to a single project; a payload-only channel
 * would fan every app's changes out to every subscriber.
 *
 * Why `globalThis`, same as the Drizzle client (see `lib/db/client.ts`): in `next dev` the
 * RSC layer and the route-handler layer are compiled into separate module
 * registries, so a module-level `const pubSub` would exist as TWO independent
 * emitters in ONE process — a publish from the data layer (which runs in the
 * route-handler/server-action registry) would never reach a subscriber created
 * by the GraphQL route. Pinning it on `globalThis` collapses every module
 * instance onto a single emitter.
 */
type Channels = {
  appChanged: [id: string, payload: string];
  databaseChanged: [id: string, payload: string];
  cleanupRunsChanged: [id: string, payload: string];
};
type ServicePubSub = ReturnType<typeof createPubSub<Channels>>;

const PUBSUB_KEY = Symbol.for("deplo.graphql.pubsub.singleton");
const g = globalThis as unknown as { [PUBSUB_KEY]?: ServicePubSub };

export const pubSub: ServicePubSub = (g[PUBSUB_KEY] ??=
  createPubSub<Channels>());

/** Notify every subscriber that this app's state changed. */
export function publishAppChanged(appId: string): void {
  pubSub.publish("appChanged", appId, appId);
}

/** Notify every subscriber that this database's state changed — same contract
 *  as {@link publishAppChanged}: the payload is just the id, "re-read it". */
export function publishDatabaseChanged(databaseId: string): void {
  pubSub.publish("databaseChanged", databaseId, databaseId);
}

/**
 * The one key the `cleanupRunsChanged` channel uses. Docker cleanup has no
 * per-resource stream to filter: the policy is instance-wide, the history spans
 * every host and only an instance admin may read it, so there is a single
 * logical channel rather than one per server — a keyed channel with a constant
 * key, so it still rides the same `subscribe(topic, id)` shape as the others.
 */
export const CLEANUP_RUNS_TOPIC = "instance";

/** Notify every subscriber that the Docker cleanup history changed — a sweep
 *  started, finished, or was pruned. Payload-free in spirit (the key is a
 *  constant): "re-read the runs". */
export function publishCleanupRunsChanged(): void {
  pubSub.publish("cleanupRunsChanged", CLEANUP_RUNS_TOPIC, CLEANUP_RUNS_TOPIC);
}

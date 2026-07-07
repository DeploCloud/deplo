import "server-only";

import { createPubSub } from "@graphql-yoga/subscription";

/**
 * In-process publish/subscribe used to push live updates to GraphQL
 * subscribers over SSE. One logical channel per project, keyed by project id:
 *
 *   pubSub.publish("serviceChanged", serviceId, serviceId)  // a service changed
 *   pubSub.subscribe("serviceChanged", serviceId)           // pings for that id
 *
 * The payload is just the service id — a publish means "this service changed,
 * re-read it". The subscription resolver reloads the service from the store and
 * emits the fresh snapshot, so subscribers never receive (and we never have to
 * serialize) a partial diff. The keyed form `[id, payload]` is what lets
 * `subscribe(topic, id)` filter to a single project; a payload-only channel
 * would fan every service's changes out to every subscriber.
 *
 * Why `globalThis`, same as the Drizzle client (see `lib/db/client.ts`): in `next dev` the
 * RSC layer and the route-handler layer are compiled into separate module
 * registries, so a module-level `const pubSub` would exist as TWO independent
 * emitters in ONE process — a publish from the data layer (which runs in the
 * route-handler/server-action registry) would never reach a subscriber created
 * by the GraphQL route. Pinning it on `globalThis` collapses every module
 * instance onto a single emitter.
 */
type Channels = { serviceChanged: [id: string, payload: string] };
type ServicePubSub = ReturnType<typeof createPubSub<Channels>>;

const PUBSUB_KEY = Symbol.for("deplo.graphql.pubsub.singleton");
const g = globalThis as unknown as { [PUBSUB_KEY]?: ServicePubSub };

export const pubSub: ServicePubSub = (g[PUBSUB_KEY] ??=
  createPubSub<Channels>());

/** Notify every subscriber that this service's state changed. */
export function publishServiceChanged(serviceId: string): void {
  pubSub.publish("serviceChanged", serviceId, serviceId);
}

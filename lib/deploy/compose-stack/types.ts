import "server-only";

import type { ResourceLimits, VolumeMount } from "../../types/container";

// ComposeDomainRoute is one routed hostname for a compose stack - the SOLE source of
// compose routing (the `domains` table is authoritative; there is no separate `exposes`).
export interface ComposeDomainRoute {
  name: string;
  // Null ⇒ unroutable (skipped - compose domains always carry a service).
  service: string | null;
  // Null ⇒ the chosen service's compose-declared port.
  port: number | null;
  // The route's TLS triplet, already resolved from its stored row by `domainTlsConfig`.
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  // Path prefix to match (empty ⇒ whole host).
  pathPrefix: string;
  // Strip `pathPrefix` before forwarding.
  stripPrefix: boolean;
  // Absolute base URL this hostname permanently redirects to, or empty/absent when
  // it serves the app.
  redirectTo?: string;
}

// ComposeStackInput is everything one render of a tenant's compose stack takes.
export interface ComposeStackInput {
  compose: string;
  // Router/service name + label namespace, e.g. `deplo-<deployKey>`.
  name: string;
  // The stack's DEPLOY KEY - what the named volumes and the `deplo.slug` label are
  // named after.
  deployKey: string;
  // Drop every service's published host `ports:`.
  stripPublishedPorts?: boolean;
  appId: string;
  // What the `deplo.project` label carries - the value the telemetry stream buckets
  // container stats by.
  trackingId?: string;
  // The routed domains - one Traefik router each, to the route's named compose service.
  domainRoutes: ComposeDomainRoute[];
  // Absolute host directory holding this project's mount files. `./<x>` bind mounts
  // are rewritten into it so each project's config files stay isolated.
  filesDir?: string;
  // App-wide HTTP Basic Auth htpasswd users (`user:$2b$…,user2:…`, raw single-`$`).
  basicAuthUsers?: string;
  // The NAMES of the project's settings env vars, injected into every service as bare
  // `- KEY` pass-throughs - the env-var analogue of the auto domain labels.
  envKeys?: string[];
  // Per-app resource caps applied to EVERY service, EXISTING-WINS: a service that sets
  // its own limit keeps it (like `envKeys`, the user's compose is authoritative).
  resources?: ResourceLimits | null;
  // The app's Storage-settings volumes, each mounted into the compose service it names
  // (empty ⇒ the stack's default service - the one a domain would route to).
  volumes?: VolumeMount[] | null;
  // The Docker network this stack's routed services join - the app's Environment, its
  // team, or a preview's own. See `lib/deploy/network.ts`.
  network: string;
  // Where to say what the render silently dropped. Absent ⇒ nobody is told.
  onWarn?: (message: string) => void;
  // DNS names already answered on this network by OTHER stacks. A service whose name is
  // in here is kept off it: Docker round-robins two `db`s. Absent ⇒ nothing held back.
  takenNames?: readonly string[];
}

// App is one compose service, read as an open bag of keys.
export type App = Record<string, unknown>;

// ComposeDoc is a parsed docker-compose document.
export type ComposeDoc = {
  services?: Record<string, App>;
  networks?: Record<string, unknown>;
  version?: unknown;
  [k: string]: unknown;
};

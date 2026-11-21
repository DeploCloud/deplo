import type { TraefikLabel } from "../traefik-overrides";
import "server-only";

import type { ResourceLimits, VolumeMount } from "../../types/container";

export interface ComposeDomainRoute {
  name: string;
  service: string | null;
  port: number | null;
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  middlewares?: string[];
  securityHeaders?: boolean;
  corsOrigins?: string[];
  pathPrefix: string;
  stripPrefix: boolean;
  redirectTo?: string;
}

export interface ComposeStackInput {
  allowTraefikLabels?: boolean;
  traefikLabels?: TraefikLabel[];
  compose: string;
  name: string;
  deployKey: string;
  stripPublishedPorts?: boolean;
  appId: string;
  trackingId?: string;
  domainRoutes: ComposeDomainRoute[];
  filesDir?: string;
  basicAuthUsers?: string;
  envKeys?: string[];
  resources?: ResourceLimits | null;
  volumes?: VolumeMount[] | null;
  network: string;
  /** The server's Docker Engine version, which decides the healthcheck keys it can take. */
  dockerVersion?: string;
  // The server's agent says Hello `deploy.probe`: a routed service's port probe is its binary, not the image's shell.
  agentProbe?: boolean;
  onWarn?: (message: string) => void;
  takenNames?: readonly string[];
  /** The App's switch: a routed service with replicas keeps each visitor on one of them. */
  stickySessions?: boolean;
  /** Data on a cluster whose agents start it under its lease: every service's restart policy is "no" (deplo#237). */
  underLease?: boolean;
}

export type App = Record<string, unknown>;

export type ComposeDoc = {
  services?: Record<string, App>;
  networks?: Record<string, unknown>;
  version?: unknown;
  [k: string]: unknown;
};

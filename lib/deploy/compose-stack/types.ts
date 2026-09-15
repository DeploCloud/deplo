import "server-only";

import type { ResourceLimits, VolumeMount } from "../../types/container";

export interface ComposeDomainRoute {
  name: string;
  service: string | null;
  port: number | null;
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  pathPrefix: string;
  stripPrefix: boolean;
  redirectTo?: string;
}

export interface ComposeStackInput {
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
  onWarn?: (message: string) => void;
  takenNames?: readonly string[];
}

export type App = Record<string, unknown>;

export type ComposeDoc = {
  services?: Record<string, App>;
  networks?: Record<string, unknown>;
  version?: unknown;
  [k: string]: unknown;
};

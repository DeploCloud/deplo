import type { ID } from "./identity";

export type DomainStatus =
  "valid" | "cloudflare" | "pending" | "misconfigured" | "error";

export type DomainEntrypoint = "websecure" | "web";

export type CertProvider = "letsencrypt" | "cloudflare" | "none" | "custom";

export interface Domain {
  id: ID;
  appId: ID;
  name: string;
  status: DomainStatus;
  primary: boolean;
  redirectTo: string | null;
  ssl: boolean;
  source?: "auto" | "custom" | "redirect";
  port?: number | null;
  entrypoint?: DomainEntrypoint;
  certProvider?: CertProvider;
  importedFrom?: string | null;
  middlewares?: string[];
  securityHeaders?: boolean;
  corsOrigins?: string[];
  pathPrefix?: string;
  stripPrefix?: boolean;
  service?: string;
  proxied?: boolean;
  tunnel?: boolean;
  /** Every server of the App's cluster answers it (ADR-0048). */
  answersEverywhere?: boolean;
  /**
   * How its certificate is checked when not over HTTP: the zone's own certificate, its own over DNS held by every
   * server (`shared`), or its own over DNS on its App's server (ADR-0049, ADR-0048 step 5).
   */
  certChallenge?: "zone" | "shared" | "dns";
  /** Why it went on the App's tunnel instead of the cluster's own zone (ADR-0049). */
  clusterFallback?: string | null;
  /** It answers everywhere, but its certificate has not reached the App's failover bundle yet. */
  failoverWaitsForCertificate?: boolean;
  createdAt: string;
}

export interface BasicAuthUser {
  id: ID;
  appId: ID;
  username: string;
  passwordEnc: string;
  imported?: boolean;
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}

/** A load-balanced App's generated address whose server is away: that server, and the App's domain to use meanwhile. */
export interface AddressAway {
  server: string;
  use: string | null;
}

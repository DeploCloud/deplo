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
  pathPrefix?: string;
  stripPrefix?: boolean;
  service?: string;
  proxied?: boolean;
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

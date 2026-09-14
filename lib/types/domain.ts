import type { ID } from "./identity";

// DomainStatus - a custom domain's DNS verification state. `valid`: an A record
// points straight at this project's server. `cloudflare`: proxied through the
// orange-cloud, so the A records are anycast IPs that mask the origin.
export type DomainStatus =
  "valid" | "cloudflare" | "pending" | "misconfigured" | "error";

// DomainEntrypoint - the Traefik entrypoint a domain's router binds to.
export type DomainEntrypoint = "websecure" | "web";

// CertProvider - how TLS is issued: the user's *choice*, distinct from `ssl`
// (whether one is active). `cloudflare` terminates at the edge, so the origin is
// served over `websecure` with a DNS-01 resolver when the proxy defines one.
export type CertProvider = "letsencrypt" | "cloudflare" | "none" | "custom";

export interface Domain {
  id: ID;
  appId: ID;
  name: string;
  status: DomainStatus;
  primary: boolean;
  // The hostname this domain answers a permanent redirect (301) to, or null when
  // it serves the app.
  redirectTo: string | null;
  ssl: boolean;
  // "auto" is the zero-config nip.io hostname Deplo generates once per project;
  // "custom" is a domain the user added and must point at this server.
  source?: "auto" | "custom" | "redirect";
  // Container port this hostname's Traefik router targets.
  port?: number | null;
  // Absent ⇒ `websecure`. `web` serves plain HTTP on :80.
  entrypoint?: DomainEntrypoint;
  // Absent ⇒ `letsencrypt`. `none` means no certificate - the router serves plain
  // HTTP and is forced onto the `web` entrypoint regardless of `entrypoint`.
  certProvider?: CertProvider;
  // The hostname this domain REPLACED on the platform it was imported from.
  importedFrom?: string | null;
  // Traefik middlewares applied to this host's router, in order, emitted as
  // `traefik.http.routers.<key>.middlewares=<m1>,<m2>,…`.
  middlewares?: string[];
  // Stored normalised: one leading slash, no trailing slash, never a scheme/host,
  // never a backtick (it is interpolated into a Traefik backtick literal).
  pathPrefix?: string;
  // Strip {@link pathPrefix} before forwarding, via a generated `stripprefix`
  // middleware prepended to {@link middlewares}, so user middlewares see the
  // already-stripped path the app sees.
  stripPrefix?: boolean;
  // COMPOSE/template stacks only: which compose service this router targets.
  service?: string;
  // The user declaring that a proxy answers for this hostname, so its A records
  // name the proxy and the DNS check can never settle `valid`. Routed anyway.
  proxied?: boolean;
  createdAt: string;
}

// BasicAuthUser - an HTTP Basic Auth credential protecting EVERY domain of a project.
export interface BasicAuthUser {
  id: ID;
  appId: ID;
  username: string;
  // AES-GCM-encrypted password. Reversible (re-hashed to htpasswd at render);
  // never in a DTO, read back only through the gated reveal.
  passwordEnc: string;
  // Carried over from another platform verbatim, so it never went through the
  // password policy or the breach check - see `addBasicAuthUser`.
  imported?: boolean;
  // Identity metadata, never a value - see {@link VarAuthor}. Null for rows
  // written before migration 0045, or once that user is deleted.
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}

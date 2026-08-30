// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { builder } from "../builder";
import { DomainStatusEnum } from "./enums";
import {
  listDomains,
  addDomain,
  dismissImportedDomains,
  updateDomain,
  verifyDomain,
  setPrimaryDomain,
  removeDomain,
  type DomainConfig,
  type DomainPatch,
} from "@/lib/data/domains";
import { rerouteApp } from "@/lib/deploy/build";
import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import type { Domain } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// These two unions are domain-local (CertProvider / DomainEntrypoint live in
// lib/types.ts but are not in the shared enums module), so they are defined here
// and exported to nothing.
const CertProviderEnum = builder.enumType("CertProvider", {
  values: ["letsencrypt", "cloudflare", "none", "custom"] as const,
});

const DomainEntrypointEnum = builder.enumType("DomainEntrypoint", {
  values: ["websecure", "web"] as const,
});

// The `www` ⇄ non-`www` pairing, expressed relative to the domain being written:
// `toThis` makes the counterpart hostname 301 here, `toCounterpart` makes THIS
// hostname 301 to its counterpart (which serves the app and inherits `primary`),
const DomainWwwRedirectEnum = builder.enumType("DomainWwwRedirect", {
  description:
    "Which half of a www / non-www pair serves the app, relative to this domain. " +
    "`toThis`: the counterpart hostname redirects here. `toCounterpart`: this " +
    "hostname redirects to its counterpart, which serves the app. `none`: no pair.",
  values: ["none", "toThis", "toCounterpart"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

// listDomains() decorates each row with its owning app's name/slug; addDomain
// and verifyDomain return a bare Domain. The ref is typed on the bare Domain and
// the decoration fields are nullable so both shapes satisfy it.
type DomainRow = Domain & { serviceName?: string; appSlug?: string };

export const DomainRef = builder.objectRef<DomainRow>("Domain").implement({
  description: "A routable hostname attached to an app (Traefik router).",
  fields: (t) => ({
    id: t.exposeID("id"),
    appId: t.exposeID("appId"),
    name: t.exposeString("name"),
    status: t.field({
      type: DomainStatusEnum,
      description:
        "DNS verification state. Only `valid` is confirmed: `cloudflare` means " +
        "the host is proxied and its origin cannot be checked from DNS, so it " +
        "is routed but unverified. A `misconfigured` host is off the router " +
        "unless `proxied` declares another proxy answers for it. See the " +
        "DomainStatus enum.",
      resolve: (d) => d.status,
    }),
    primary: t.exposeBoolean("primary"),
    redirectTo: t.exposeString("redirectTo", {
      nullable: true,
      description:
        "Hostname this domain answers a permanent 301 to (the canonical half of " +
        "its www / non-www pair), or null when it serves the app itself.",
    }),
    ssl: t.exposeBoolean("ssl"),
    source: t.exposeString("source", { nullable: true }),
    port: t.exposeInt("port", { nullable: true }),
    entrypoint: t.field({
      type: DomainEntrypointEnum,
      nullable: true,
      resolve: (d) => d.entrypoint ?? null,
    }),
    certProvider: t.field({
      type: CertProviderEnum,
      nullable: true,
      description:
        "How this domain's TLS certificate is issued. Set to `cloudflare` " +
        "automatically when a DNS check finds the host proxied and it still had " +
        "no certificate - Cloudflare already serves it over HTTPS. `custom` " +
        "serves it over HTTPS from a certificate installed on the owning server " +
        "(see `addServerCertificate`) and asks no ACME provider for one. Null on " +
        "rows written before the field existed (they route as `letsencrypt`).",
      resolve: (d) => d.certProvider ?? null,
    }),
    proxied: t.exposeBoolean("proxied", {
      nullable: true,
      description:
        "The owner's declaration that a proxy (a CDN, a reverse proxy, a load " +
        "balancer) answers for this hostname. Its A records then name the proxy, " +
        "never this server, so the DNS check can only ever settle " +
        "`misconfigured` - this is what keeps the host routed anyway, and makes " +
        "its URL https (the proxy terminates TLS). The declared twin of the " +
        "`cloudflare` status, which is detected from Cloudflare's published ranges.",
    }),
    middlewares: t.exposeStringList("middlewares", { nullable: true }),
    pathPrefix: t.exposeString("pathPrefix", { nullable: true }),
    stripPrefix: t.exposeBoolean("stripPrefix", { nullable: true }),
    service: t.exposeString("service", { nullable: true }),
    importedFrom: t.exposeString("importedFrom", {
      nullable: true,
      description:
        "The hostname this domain REPLACED on the platform the app was imported " +
        "from, or null when it is the address the app always had. An import " +
        "cannot keep the source's own throwaway host (it carries that server's " +
        "IP) nor a name another team here already serves, so the route is " +
        "re-hosted onto an address Deplo mints - this is what the app's Domains " +
        "section reads to say which address became which. Cleared by " +
        "`dismissImportedDomains`.",
    }),
    createdAt: t.exposeString("createdAt"),
    // Present only on rows from listDomains (decorated with the owning project);
    // null on a freshly-added/verified domain returned bare by the data layer.
    serviceName: t.exposeString("serviceName", { nullable: true }),
    appSlug: t.exposeString("appSlug", { nullable: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

// The routing knobs a user sets when adding a domain - mirrors DomainConfig in
// the data layer. All optional; an omitted certProvider means NO certificate
// (plain HTTP) - a cert is only registered when explicitly requested.
const DomainConfigInput = builder.inputType("DomainConfigInput", {
  description:
    "Per-domain routing config; an omitted certProvider means no certificate " +
    "(plain HTTP), unless the add-time DNS check finds the host proxied through " +
    "Cloudflare, then it is stored as `cloudflare`.",
  fields: (t) => ({
    port: t.int({ required: false }),
    entrypoint: t.field({ type: DomainEntrypointEnum, required: false }),
    certProvider: t.field({ type: CertProviderEnum, required: false }),
    middlewares: t.stringList({ required: false }),
    pathPrefix: t.string({ required: false }),
    stripPrefix: t.boolean({ required: false }),
    service: t.string({ required: false }),
    proxied: t.boolean({ required: false }),
    www: t.field({ type: DomainWwwRedirectEnum, required: false }),
  }),
});

// A full-domain edit - every field the Edit dialog can change. Mirrors the
// DomainPatch interface; each field optional so the mutation sends only what
// changed. `port`/`entrypoint` accept null to clear an override (revert to auto).
const DomainPatchInput = builder.inputType("DomainPatchInput", {
  description:
    "Partial domain edit; only the provided fields are changed. Null clears an override.",
  fields: (t) => ({
    name: t.string({ required: false }),
    port: t.int({ required: false }),
    entrypoint: t.field({ type: DomainEntrypointEnum, required: false }),
    certProvider: t.field({ type: CertProviderEnum, required: false }),
    middlewares: t.stringList({ required: false }),
    pathPrefix: t.string({ required: false }),
    stripPrefix: t.boolean({ required: false }),
    service: t.string({ required: false }),
    proxied: t.boolean({ required: false }),
    www: t.field({ type: DomainWwwRedirectEnum, required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  domains: t.field({
    type: [DomainRef],
    authScopes: { loggedIn: true },
    description:
      "Domains in the active team, primary first. Optionally filtered to one project.",
    args: { appId: t.arg.string({ required: false }) },
    resolve: (_r, { appId }) => listDomains(appId ?? undefined),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every domain server action)                              */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  dismissImportedDomains: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    description:
      "Stop telling this app that its addresses changed when it was imported: " +
      "clears `importedFrom` on every one of its domains. Per app on purpose - " +
      "a migration brings over many, and one blanket dismissal would hide the " +
      "fact on every app nobody has looked at yet.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await dismissImportedDomains(appId);
      return true;
    },
  }),
  addDomain: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    args: {
      appId: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
      config: t.arg({ type: DomainConfigInput, required: false }),
    },
    resolve: async (_r, { appId, name, config }) => {
      const cfg: DomainConfig = {
        port: config?.port ?? null,
        // Enum args arrive as the runtime string union; pass through as-is.
        entrypoint: config?.entrypoint ?? undefined,
        certProvider: config?.certProvider ?? undefined,
        middlewares: config?.middlewares ?? undefined,
        pathPrefix: config?.pathPrefix ?? undefined,
        stripPrefix: config?.stripPrefix ?? undefined,
        service: config?.service ?? undefined,
        proxied: config?.proxied ?? undefined,
        www: config?.www ?? undefined,
      };
      const domain = await addDomain(appId, name, cfg);
      await applyRouting(appId);
      return domain;
    },
  }),
  updateDomain: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    description:
      "Apply a full edit to a domain and return the updated domain (reloaded).",
    args: {
      id: t.arg.string({ required: true }),
      patch: t.arg({ type: DomainPatchInput, required: true }),
    },
    resolve: async (_r, { id, patch }) => {
      const next: DomainPatch = {
        name: patch.name ?? undefined,
        // `port` is tri-state in the patch (value / null clears / absent leaves):
        // only forward it when the arg was supplied.
        port: patch.port === undefined ? undefined : patch.port,
        entrypoint:
          patch.entrypoint === undefined ? undefined : patch.entrypoint,
        certProvider: patch.certProvider ?? undefined,
        middlewares: patch.middlewares ?? undefined,
        pathPrefix: patch.pathPrefix ?? undefined,
        stripPrefix: patch.stripPrefix ?? undefined,
        service: patch.service ?? undefined,
        proxied: patch.proxied ?? undefined,
        www: patch.www ?? undefined,
      };
      const appId = await updateDomain(id, next);
      await applyRouting(appId);
      return reloadDomain(id, appId);
    },
  }),
  verifyDomain: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    description:
      "Re-check the domain's DNS and (re)issue its certificate. A check that " +
      "finds the host proxied through Cloudflare also moves a certificate-less " +
      "domain onto the `cloudflare` provider.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      // Verifying is what flips a host to `valid` - i.e. what makes it routable
      // in the first place. Without the reroute the domain reports "verified"
      // while the container still carries labels that never mentioned it.
      const domain = await verifyDomain(id);
      // Re-apply routing when the check changed anything, or whenever the host is
      // routable (so a manual Verify can still heal drifted labels).
      const routable = isRoutableDomain(domain);
      if (domain.statusChanged || routable) await applyRouting(domain.appId);
      return domain;
    },
  }),
  setPrimaryDomain: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    description:
      "Make this domain its app's primary (canonical) host. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await applyRouting(await setPrimaryDomain(id));
      return true;
    },
  }),
  removeDomain: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    description: "Remove the domain so it stops routing. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await applyRouting(await removeDomain(id));
      return true;
    },
  }),
}));

/**
 * Push an app's current routing to its RUNNING container. The write is already
 * committed when this runs, so a failure has to say so: told only "unreachable",
 * a caller (an AI agent especially) retries an add that in fact landed.
 */
async function applyRouting(appId: string): Promise<void> {
  try {
    await rerouteApp(appId);
  } catch (e) {
    throw new Error(
      `The domain was saved, but the routing could not be applied on the server: ${
        e instanceof Error ? e.message : String(e)
      }. Deploy the app to apply it.`,
    );
  }
}

/** Reload a domain by id after updateDomain (which returns only the appId)
 * so the mutation can return the updated entity. Scopes the lookup to the
 * affected project, matching project.ts's reloadApp helper. */
async function reloadDomain(id: string, appId: string): Promise<DomainRow> {
  const all = await listDomains(appId);
  const found = all.find((d) => d.id === id);
  if (!found) throw new Error("Domain not found");
  return found;
}

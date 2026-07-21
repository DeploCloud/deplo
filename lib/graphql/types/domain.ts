import { builder } from "../builder";
import { DomainStatusEnum } from "./enums";
import {
  listDomains,
  addDomain,
  updateDomain,
  verifyDomain,
  setPrimaryDomain,
  removeDomain,
  type DomainConfig,
  type DomainPatch,
} from "@/lib/data/domains";
import { rerouteApp } from "@/lib/deploy/build";
import type { Domain } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// These two unions are domain-local (CertProvider / DomainEntrypoint live in
// lib/types.ts but are not in the shared enums module), so they are defined here
// and exported to nothing. Plain alphanumeric values ⇒ the wire names match the
// runtime strings 1:1, no object-form mapping needed.
const CertProviderEnum = builder.enumType("CertProvider", {
  values: ["letsencrypt", "cloudflare", "none"] as const,
});

const DomainEntrypointEnum = builder.enumType("DomainEntrypoint", {
  values: ["websecure", "web"] as const,
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
        "is routed but unverified. See the DomainStatus enum.",
      resolve: (d) => d.status,
    }),
    primary: t.exposeBoolean("primary"),
    redirectTo: t.exposeString("redirectTo", { nullable: true }),
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
        "no certificate — Cloudflare already serves it over HTTPS. Null on rows " +
        "written before the field existed (they route as `letsencrypt`).",
      resolve: (d) => d.certProvider ?? null,
    }),
    middlewares: t.exposeStringList("middlewares", { nullable: true }),
    pathPrefix: t.exposeString("pathPrefix", { nullable: true }),
    stripPrefix: t.exposeBoolean("stripPrefix", { nullable: true }),
    service: t.exposeString("service", { nullable: true }),
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

// The routing knobs a user sets when adding a domain — mirrors DomainConfig in
// the data layer. All optional; an omitted certProvider means NO certificate
// (plain HTTP) — a cert is only registered when explicitly requested.
const DomainConfigInput = builder.inputType("DomainConfigInput", {
  description:
    "Per-domain routing config; an omitted certProvider means no certificate " +
    "(plain HTTP), unless the add-time DNS check finds the host proxied through " +
    "Cloudflare — then it is stored as `cloudflare`.",
  fields: (t) => ({
    port: t.int({ required: false }),
    entrypoint: t.field({ type: DomainEntrypointEnum, required: false }),
    certProvider: t.field({ type: CertProviderEnum, required: false }),
    middlewares: t.stringList({ required: false }),
    pathPrefix: t.string({ required: false }),
    stripPrefix: t.boolean({ required: false }),
    service: t.string({ required: false }),
  }),
});

// A full-domain edit — every field the Edit dialog can change. Mirrors the
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
        entrypoint: patch.entrypoint === undefined ? undefined : patch.entrypoint,
        certProvider: patch.certProvider ?? undefined,
        middlewares: patch.middlewares ?? undefined,
        pathPrefix: patch.pathPrefix ?? undefined,
        stripPrefix: patch.stripPrefix ?? undefined,
        service: patch.service ?? undefined,
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
      // Verifying is what flips a host to `valid` — i.e. what makes it routable
      // in the first place. Without the reroute the domain reports "verified"
      // while the container still carries labels that never mentioned it.
      const domain = await verifyDomain(id);
      // Re-apply routing when the check changed anything, or whenever the host
      // is routable (so a manual Verify can still heal drifted labels). The one
      // case skipped — an unroutable status re-confirming itself — is exactly
      // what the domains page's automatic interval checks produce while the
      // user is still setting DNS up; skipping it keeps that polling free of
      // per-check agent round-trips.
      const routable =
        domain.status === "valid" || domain.status === "cloudflare";
      if (domain.statusChanged || routable) await applyRouting(domain.appId);
      return domain;
    },
  }),
  setPrimaryDomain: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    description: "Make this domain its app's primary (canonical) host. Returns true.",
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
 * Push an app's current routing to its RUNNING container.
 *
 * A router's rule, path, strip middleware and target port are baked into the
 * container's Traefik labels at deploy time, so every domain write here is
 * DB-only until the stack is re-rendered. Each `lib/data/domains` mutation
 * returns the affected appId precisely "so the caller can re-apply routing" —
 * and nobody did, which is why editing a domain's path or strip flag appeared to
 * do nothing at all: the row changed, the labels didn't.
 *
 * `rerouteApp` is the lightweight, label-only path (no build, no git, no env
 * regeneration) and it is a no-op when there is nothing to do: it reports
 * "unchanged" when the rendered labels already match (so a routing-neutral edit
 * never restarts a container) and "deferred" when the app isn't running (the
 * stack file is still rewritten, so the right labels are in place when it next
 * comes up). It throws only on a real docker failure for an ACTIVE app, which is
 * exactly the case the user must hear about — the domain is saved either way, but
 * the routing they asked for is not live, so we surface it rather than swallow it.
 *
 * Authorization is already settled when we get here: `appId` is whatever the
 * lib/data domain mutation just returned, and every one of them gates on
 * `requireCapability("manage_domains")` + the app's team + its folder before
 * writing. So this deliberately calls the deploy-engine primitive rather than
 * `reloadApp`, whose own gate is `deploy` — a member who may manage domains but
 * not deploy must still be able to route the domain they just changed.
 */
async function applyRouting(appId: string): Promise<void> {
  await rerouteApp(appId);
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

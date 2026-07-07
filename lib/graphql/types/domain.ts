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

// listDomains() decorates each row with its owning project's name/slug; addDomain
// and verifyDomain return a bare Domain. The ref is typed on the bare Domain and
// the decoration fields are nullable so both shapes satisfy it.
type DomainRow = Domain & { serviceName?: string; serviceSlug?: string };

export const DomainRef = builder.objectRef<DomainRow>("Domain").implement({
  description: "A routable hostname attached to a project (Traefik router).",
  fields: (t) => ({
    id: t.exposeID("id"),
    serviceId: t.exposeID("serviceId"),
    name: t.exposeString("name"),
    status: t.field({ type: DomainStatusEnum, resolve: (d) => d.status }),
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
    serviceSlug: t.exposeString("serviceSlug", { nullable: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

// The routing knobs a user sets when adding a domain — mirrors DomainConfig in
// the data layer. All optional; omitted fields fall back to the HTTPS defaults.
const DomainConfigInput = builder.inputType("DomainConfigInput", {
  description:
    "Per-domain routing config; omitted fields take the HTTPS/letsencrypt defaults.",
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
    args: { serviceId: t.arg.string({ required: false }) },
    resolve: (_r, { serviceId }) => listDomains(serviceId ?? undefined),
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
      serviceId: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
      config: t.arg({ type: DomainConfigInput, required: false }),
    },
    resolve: (_r, { serviceId, name, config }) => {
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
      return addDomain(serviceId, name, cfg);
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
      const serviceId = await updateDomain(id, next);
      return reloadDomain(id, serviceId);
    },
  }),
  verifyDomain: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    description: "Re-check the domain's DNS and (re)issue its certificate.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => verifyDomain(id),
  }),
  setPrimaryDomain: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    description: "Make this domain its project's primary (canonical) host. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await setPrimaryDomain(id);
      return true;
    },
  }),
  removeDomain: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    description: "Remove the domain so it stops routing. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await removeDomain(id);
      return true;
    },
  }),
}));

/** Reload a domain by id after updateDomain (which returns only the serviceId)
 * so the mutation can return the updated entity. Scopes the lookup to the
 * affected project, matching project.ts's reloadService helper. */
async function reloadDomain(id: string, serviceId: string): Promise<DomainRow> {
  const all = await listDomains(serviceId);
  const found = all.find((d) => d.id === id);
  if (!found) throw new Error("Domain not found");
  return found;
}

import { builder } from "../builder";
import { DomainStatusEnum } from "./enums";
import {
  listDomains,
  addDomain,
  updateDomain,
  removeDomain,
  type DomainConfig,
  type DomainPatch,
} from "@/lib/data/domains/crud";
import { verifyDomain } from "@/lib/data/domains/dns-check";
import { dismissImportedDomains } from "@/lib/data/domains/imported-routes";
import { setPrimaryDomain } from "@/lib/data/domains/primary-domain";
import { rerouteApp } from "@/lib/deploy/build/reroute";
import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import type { Domain } from "@/lib/types/domain";
import { setDomainAnswersEverywhere } from "@/lib/data/domains/answer-switch";
import { moveDomainToCluster } from "@/lib/data/domains/cluster-answer";
import { answerCertificatesMissing } from "@/lib/data/clusters/answer-certs";
import { syncClusterAnswerDnsSoon } from "@/lib/data/clusters/answer-dns";
import { loadAppGraph } from "@/lib/data/app-graph-load";
import {
  routeAfterAnswers,
  syncNameForwardersSoon,
} from "@/lib/data/clusters/forwarders";

const CertProviderEnum = builder.enumType("CertProvider", {
  values: ["letsencrypt", "cloudflare", "none", "custom"] as const,
});

const DomainEntrypointEnum = builder.enumType("DomainEntrypoint", {
  values: ["websecure", "web"] as const,
});

const DomainWwwRedirectEnum = builder.enumType("DomainWwwRedirect", {
  description:
    "Which half of a www / non-www pair serves the app, relative to this domain. " +
    "`toThis`: the counterpart hostname redirects here. `toCounterpart`: this " +
    "hostname redirects to its counterpart, which serves the app. `none`: no pair.",
  values: ["none", "toThis", "toCounterpart"] as const,
});

type DomainRow = Domain & {
  serviceName?: string;
  appSlug?: string;
  autoDns?: boolean;
};

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
        "How this domain's TLS certificate is issued. Set to `letsencrypt` " +
        "automatically when a DNS check finds the host proxied through Cloudflare " +
        "and it still had no certificate; once proxied, Deplo matches it to " +
        "Cloudflare's SSL mode (`none` under Flexible). `custom` " +
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
    answersEverywhere: t.boolean({
      description:
        "Answers on every server of the App's cluster (ADR-0048): each server passes its encrypted " +
        "traffic to the one that runs the App, and DNS lists every healthy server.",
      resolve: (d) => d.answersEverywhere === true,
    }),
    failoverWaitsForCertificate: t.boolean({
      description:
        "True while the domain answers on every server but its certificate has not reached the App's " +
        "failover bundle yet, so a failover would have to order a new one. False otherwise.",
      resolve: async (d) =>
        d.answersEverywhere === true &&
        (await answerCertificatesMissing(d.appId)).includes(d.name),
    }),
    tunnel: t.boolean({
      description:
        "Served through a Cloudflare Tunnel Deplo runs beside the owning " +
        "server's proxy: Cloudflare holds the certificate, so HTTPS is not " +
        "configurable, and the server needs no open port.",
      resolve: (d) => d.tunnel === true,
    }),
    clusterFallback: t.string({
      nullable: true,
      description:
        "Why this domain of a cluster App is on its Cloudflare Tunnel instead of the cluster's own DNS zone, in " +
        "plain words; null when it was not a fallback. `moveDomainToCluster` moves it once that is fixed.",
      resolve: (d) => d.clusterFallback ?? null,
    }),
    recordSwitchedAt: t.string({
      nullable: true,
      description:
        "When Deplo last rewrote this domain's DNS record (a switch from the tunnel to the cluster). Resolvers may " +
        "serve the old record for up to 5 minutes after: the domain row counts that wait down.",
      resolve: (d) => d.recordSwitchedAt ?? null,
    }),
    autoDns: t.boolean({
      description:
        "Deplo created this domain's DNS record through a connected DNS " +
        "provider, and removes it with the domain.",
      resolve: (d) => d.autoDns === true,
    }),
    middlewares: t.exposeStringList("middlewares", { nullable: true }),
    securityHeaders: t.boolean({
      description:
        "Adds nosniff, same-origin framing and a strict referrer policy to every response. On for a domain added since the setting existed.",
      resolve: (d) => d.securityHeaders === true,
    }),
    corsOrigins: t.stringList({
      description:
        "Browser origins allowed to call this domain (CORS). Empty means CORS is off; `*` allows any.",
      resolve: (d) => d.corsOrigins ?? [],
    }),
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
    serviceName: t.exposeString("serviceName", { nullable: true }),
    appSlug: t.exposeString("appSlug", { nullable: true }),
  }),
});

const DomainConfigInput = builder.inputType("DomainConfigInput", {
  description:
    "Per-domain routing config; an omitted certProvider means no certificate " +
    "(plain HTTP), unless the add-time DNS check finds the host proxied through " +
    "Cloudflare, then it is stored as `letsencrypt`.",
  fields: (t) => ({
    port: t.int({ required: false }),
    entrypoint: t.field({ type: DomainEntrypointEnum, required: false }),
    certProvider: t.field({ type: CertProviderEnum, required: false }),
    middlewares: t.stringList({ required: false }),
    securityHeaders: t.boolean({
      required: false,
      description: "Omitted means on.",
    }),
    corsOrigins: t.stringList({ required: false }),
    pathPrefix: t.string({ required: false }),
    stripPrefix: t.boolean({ required: false }),
    service: t.string({ required: false }),
    proxied: t.boolean({
      required: false,
      description:
        "Another proxy answers for it. In a domain connected for automatic DNS, " +
        "Deplo makes its record with Cloudflare's proxy on; omitted, DNS only.",
    }),
    tunnel: t.boolean({
      required: false,
      description:
        "Serve it through a Cloudflare Tunnel. Needs a domain connected for " +
        "automatic DNS that covers this name; certProvider, entrypoint, " +
        "proxied and www are then ignored. For an App on a cluster, false " +
        "asks the cluster's own DNS zone to answer it instead (made first " +
        "when the cluster has none, by an instance admin), and omitted picks " +
        "the zone when it can and the tunnel otherwise (ADR-0049).",
    }),
    www: t.field({ type: DomainWwwRedirectEnum, required: false }),
  }),
});

const DomainPatchInput = builder.inputType("DomainPatchInput", {
  description:
    "Partial domain edit; only the provided fields are changed. Null clears an override.",
  fields: (t) => ({
    name: t.string({ required: false }),
    port: t.int({ required: false }),
    entrypoint: t.field({ type: DomainEntrypointEnum, required: false }),
    certProvider: t.field({ type: CertProviderEnum, required: false }),
    middlewares: t.stringList({ required: false }),
    securityHeaders: t.boolean({ required: false }),
    corsOrigins: t.stringList({ required: false }),
    pathPrefix: t.string({ required: false }),
    stripPrefix: t.boolean({ required: false }),
    service: t.string({ required: false }),
    proxied: t.boolean({
      required: false,
      description:
        "Another proxy answers for it. When Deplo made its record in Cloudflare, " +
        "that record's proxy follows: on, or DNS only straight to the server.",
    }),
    tunnel: t.boolean({
      required: false,
      description:
        "Serve it through the server's Cloudflare Tunnel, or point it back at the " +
        "server. Only for a domain whose record Deplo made, of an App off a cluster.",
    }),
    www: t.field({ type: DomainWwwRedirectEnum, required: false }),
  }),
});

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

builder.mutationFields((t) => ({
  dismissImportedDomains: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t dismiss these imported domains with your current team role. Ask a team admin for the Manage domains capability.",
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
    unauthorizedError: () =>
      "You can’t add a domain with your current team role. Ask a team admin for the Manage domains capability.",
    args: {
      appId: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
      config: t.arg({ type: DomainConfigInput, required: false }),
    },
    resolve: async (_r, { appId, name, config }) => {
      const cfg: DomainConfig = {
        port: config?.port ?? null,
        entrypoint: config?.entrypoint ?? undefined,
        certProvider: config?.certProvider ?? undefined,
        middlewares: config?.middlewares ?? undefined,
        securityHeaders: config?.securityHeaders ?? undefined,
        corsOrigins: config?.corsOrigins ?? undefined,
        pathPrefix: config?.pathPrefix ?? undefined,
        stripPrefix: config?.stripPrefix ?? undefined,
        service: config?.service ?? undefined,
        proxied: config?.proxied ?? undefined,
        tunnel: config?.tunnel ?? undefined,
        www: config?.www ?? undefined,
      };
      const domain = await addDomain(appId, name, cfg);
      if (domain.answersEverywhere) await routeOnEveryServer(appId);
      else await applyRouting(appId);
      return domain;
    },
  }),
  moveDomainToCluster: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t change this domain with your current team role. Ask a team admin for the Manage domains capability.",
    description:
      "Moves a cluster App's domain from its Cloudflare Tunnel to the cluster's own DNS zone (ADR-0049): Deplo " +
      "points its record in Cloudflare at the zone, DNS only, and every server of the cluster answers it. The zone " +
      "is made first when the cluster has none, which takes an instance admin. Refused, with the reason, while the " +
      "zone cannot answer.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      const appId = await moveDomainToCluster(id);
      await routeOnEveryServer(appId);
      return reloadDomain(id, appId);
    },
  }),
  updateDomain: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t edit this domain with your current team role. Ask a team admin for the Manage domains capability.",
    description:
      "Apply a full edit to a domain and return the updated domain (reloaded).",
    args: {
      id: t.arg.string({ required: true }),
      patch: t.arg({ type: DomainPatchInput, required: true }),
    },
    resolve: async (_r, { id, patch }) => {
      const next: DomainPatch = {
        name: patch.name ?? undefined,
        port: patch.port === undefined ? undefined : patch.port,
        entrypoint:
          patch.entrypoint === undefined ? undefined : patch.entrypoint,
        certProvider: patch.certProvider ?? undefined,
        middlewares: patch.middlewares ?? undefined,
        securityHeaders: patch.securityHeaders ?? undefined,
        corsOrigins: patch.corsOrigins ?? undefined,
        pathPrefix: patch.pathPrefix ?? undefined,
        stripPrefix: patch.stripPrefix ?? undefined,
        service: patch.service ?? undefined,
        proxied: patch.proxied ?? undefined,
        tunnel: patch.tunnel ?? undefined,
        www: patch.www ?? undefined,
      };
      const appId = await updateDomain(id, next);
      await applyRouting(appId);
      return reloadDomain(id, appId);
    },
  }),
  setDomainAnswersEverywhere: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t change this domain with your current team role. Ask a team admin for the Manage domains capability.",
    description:
      'Turn "Answer on every server" on or off for a domain of a cluster App (ADR-0048). Refused, with the reason, ' +
      "for a domain it cannot work for: off a cluster, a generated name, plain HTTP, a Cloudflare tunnel, a hostname " +
      "shared by path, a proxy with HTTP/3, or past the 200 Apps a cluster's servers carry.",
    args: {
      id: t.arg.string({ required: true }),
      on: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, on }) => {
      const appId = await setDomainAnswersEverywhere(id, on);
      const clusterId = (await loadAppGraph(appId))?.clusterId;
      if (on) await routeOnEveryServer(appId);
      else {
        await applyRouting(appId);
        if (clusterId) {
          syncNameForwardersSoon(clusterId);
          syncClusterAnswerDnsSoon(clusterId);
        }
      }
      return reloadDomain(id, appId);
    },
  }),
  verifyDomain: t.field({
    type: DomainRef,
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t verify this domain with your current team role. Ask a team admin for the Manage domains capability.",
    description:
      "Re-check the domain's DNS and (re)issue its certificate. A check that " +
      "finds the host proxied through Cloudflare moves a certificate-less domain " +
      "onto `letsencrypt`; one already proxied is matched to Cloudflare's SSL mode.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      const domain = await verifyDomain(id);
      const routable = isRoutableDomain(domain);
      if (domain.statusChanged || routable) await applyRouting(domain.appId);
      return domain;
    },
  }),
  setPrimaryDomain: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t set the primary domain with your current team role. Ask a team admin for the Manage domains capability.",
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
    unauthorizedError: () =>
      "You can’t remove this domain with your current team role. Ask a team admin for the Manage domains capability.",
    description: "Remove the domain so it stops routing. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await applyRouting(await removeDomain(id), "removed");
      return true;
    },
  }),
}));

async function applyRouting(
  appId: string,
  done: "saved" | "removed" = "saved",
): Promise<void> {
  try {
    await rerouteApp(appId);
  } catch (e) {
    throw new Error(
      `The domain was ${done}, but its route did not apply: ${
        e instanceof Error ? e.message : String(e)
      }.`,
    );
  }
}

/** The proxies first, the App's router after: a certificate order's check may land on any server. */
async function routeOnEveryServer(appId: string): Promise<void> {
  const clusterId = (await loadAppGraph(appId))?.clusterId;
  if (!clusterId) return applyRouting(appId);
  void routeAfterAnswers(clusterId, appId).catch((e) =>
    console.warn(
      `[answer-switch] ${appId}: ${e instanceof Error ? e.message : String(e)}`,
    ),
  );
  syncClusterAnswerDnsSoon(clusterId);
}

async function reloadDomain(id: string, appId: string): Promise<DomainRow> {
  const all = await listDomains(appId);
  const found = all.find((d) => d.id === id);
  if (!found) throw new Error("Domain not found");
  return found;
}

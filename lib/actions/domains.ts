"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  addDomain,
  removeDomain,
  verifyDomain,
  setPrimaryDomain,
  updateDomain,
  syncProductionUrl,
} from "@/lib/data/domains";
import { rerouteProject } from "@/lib/deploy/build";

/** The per-domain routing knobs shared by the add and update schemas: entrypoint,
 * certificate provider, and the middleware chain. `port` is declared separately
 * (optional on add, nullable-required on update) so it isn't repeated here. */
const routingFields = {
  entrypoint: z.enum(["websecure", "web"]),
  certProvider: z.enum(["letsencrypt", "cloudflare", "none"]),
  // Already split + trimmed client-side; the data layer normalises again.
  middlewares: z.array(z.string().max(200)).max(20),
  // A Traefik PathPrefix this host routes; normalised/validated by the data
  // layer (normalizePath drops backticks, forces a single leading slash).
  pathPrefix: z.string().max(2000),
  stripPrefix: z.boolean(),
  // The compose service this host targets (compose stacks only); validated
  // against the project's compose file by the data layer.
  service: z.string().max(200),
} as const;

const addSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(3).max(253),
  // Container port this host routes to. Omitted ⇒ the project's default port.
  port: z.number().int().min(1).max(65535).nullable().optional(),
  // The routing knobs are optional on add (the dialog can omit them to take the
  // HTTPS/letsencrypt defaults); the data layer fills the gaps. `entrypoint`
  // omitted ⇒ auto (derived from the cert provider).
  entrypoint: routingFields.entrypoint.optional(),
  certProvider: routingFields.certProvider.optional(),
  middlewares: routingFields.middlewares.optional(),
  pathPrefix: routingFields.pathPrefix.optional(),
  stripPrefix: routingFields.stripPrefix.optional(),
  service: routingFields.service.optional(),
});

export async function addDomainAction(
  input: z.input<typeof addSchema>
): Promise<ActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const { projectId, name, ...config } = parsed.data;
  const res = await run(() => addDomain(projectId, name, config));
  // A new domain is `pending` (no DNS yet), so it doesn't route and doesn't
  // become the canonical productionUrl until it's verified — just refresh the
  // tables so it shows up.
  if (res.ok) revalidateProjectViews();
  return res as ActionResult;
}

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(3).max(253),
  // null clears the port override (revert to the project's default port).
  port: z.number().int().min(1).max(65535).nullable(),
  // null ⇒ auto entrypoint (the data layer deletes the field so domainTlsConfig
  // derives it); a concrete value ⇒ manual mode. The Edit dialog always sends
  // one or the other (never omitted) because it edits the full routing config.
  entrypoint: routingFields.entrypoint.nullable(),
  certProvider: routingFields.certProvider,
  middlewares: routingFields.middlewares,
  pathPrefix: routingFields.pathPrefix,
  stripPrefix: routingFields.stripPrefix,
  service: routingFields.service,
});

/**
 * Edit every per-domain value at once (the Edit dialog): name, port override,
 * entrypoint, certificate provider and the middleware chain. Persists the patch,
 * then re-applies routing so the running stack picks up the new Traefik labels
 * instantly (no redeploy) when the project is active — deferred otherwise.
 * `syncProductionUrl` runs because a rename can move the canonical URL for the
 * primary domain.
 */
export async function updateDomainAction(
  input: z.input<typeof updateSchema>,
): Promise<ActionResult<string>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const { id, ...patch } = parsed.data;
  const res = await run(async () => {
    const projectId = await updateDomain(id, patch);
    const status = await rerouteProject(projectId);
    syncProductionUrl(projectId);
    return rerouteMessage(status, "Domain updated");
  });
  if (res.ok) revalidateProjectViews();
  return res;
}

export async function verifyDomainAction(
  id: string,
): Promise<ActionResult<string>> {
  // Verify, then re-apply routing: a domain that just became valid should start
  // serving immediately (and one that fell out of valid should stop). Routing
  // change only matters when the project is live; reroute no-ops otherwise.
  const res = await run(async () => {
    const dom = await verifyDomain(id);
    const status = await rerouteProject(dom.projectId);
    syncProductionUrl(dom.projectId);
    return rerouteMessage(status, dom.status === "valid" ? "verified" : "");
  });
  if (res.ok) revalidateProjectViews();
  return res;
}

export async function setPrimaryDomainAction(
  id: string,
): Promise<ActionResult<string>> {
  // Flip the primary flag, then re-apply Traefik routing to the running stack so
  // the switch is instant (no redeploy). The primary IS the canonical URL the
  // moment it's chosen, so productionUrl follows it immediately — even when the
  // reroute is deferred (project not currently running), the title-bar URL must
  // reflect the new primary, not lag a deploy behind.
  const res = await run(async () => {
    const projectId = await setPrimaryDomain(id);
    const status = await rerouteProject(projectId);
    syncProductionUrl(projectId);
    return rerouteMessage(status, "Primary domain updated");
  });
  if (res.ok) revalidateProjectViews();
  return res;
}

export async function removeDomainAction(
  id: string,
): Promise<ActionResult<string>> {
  // Remove, then re-apply routing so the removed host stops being served on the
  // running container, and re-point productionUrl (the removed domain may have
  // been the primary).
  const res = await run(async () => {
    const projectId = await removeDomain(id);
    const status = await rerouteProject(projectId);
    syncProductionUrl(projectId);
    return rerouteMessage(status, "Domain removed");
  });
  if (res.ok) revalidateProjectViews();
  return res;
}

/** Refresh every view that shows a domain or a project's canonical URL: the
 * domains tables and — crucially — the project layout title bar, which reads
 * `project.productionUrl`. The `[slug]` layout is a dynamic segment, so it needs
 * the route pattern + "layout" type to invalidate all instances. */
function revalidateProjectViews(): void {
  revalidatePath("/domains");
  revalidatePath("/projects");
  revalidatePath("/(dashboard)/projects/[slug]", "layout");
}

/** Human toast text for a reroute outcome. "deferred" means the change is saved
 * but applies on the next deploy/start (project not currently active). */
function rerouteMessage(
  status: "rerouted" | "unchanged" | "deferred",
  done: string,
): string {
  if (status === "deferred")
    return done
      ? `${done} — applies on the next deploy`
      : "Saved — applies on the next deploy";
  return done || "Routing updated";
}

"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  addDomain,
  removeDomain,
  verifyDomain,
  setPrimaryDomain,
  setDomainPort,
  syncProductionUrl,
} from "@/lib/data/domains";
import { rerouteProject } from "@/lib/deploy/build";

const addSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(3).max(253),
  // Container port this host routes to. Omitted ⇒ the project's default port.
  port: z.number().int().min(1).max(65535).nullable().optional(),
});

export async function addDomainAction(
  input: z.input<typeof addSchema>
): Promise<ActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() =>
    addDomain(parsed.data.projectId, parsed.data.name, parsed.data.port ?? null)
  );
  // A new domain is `pending` (no DNS yet), so it doesn't route and doesn't
  // become the canonical productionUrl until it's verified — just refresh the
  // tables so it shows up.
  if (res.ok) revalidateProjectViews();
  return res as ActionResult;
}

const portSchema = z.object({
  id: z.string().min(1),
  // null clears the override (revert to the project's default port).
  port: z.number().int().min(1).max(65535).nullable(),
});

export async function setDomainPortAction(
  input: z.input<typeof portSchema>
): Promise<ActionResult<string>> {
  const parsed = portSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  // Persist the port, then re-apply routing so the running stack picks up the
  // new Traefik target port instantly (no redeploy) when the project is active;
  // deferred otherwise.
  const res = await run(async () => {
    const projectId = await setDomainPort(parsed.data.id, parsed.data.port);
    const status = await rerouteProject(projectId);
    return rerouteMessage(status, "Port updated");
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

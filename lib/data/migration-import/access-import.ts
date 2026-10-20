import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  teamRoles as teamRolesTable,
} from "../../db/schema/control-plane/access-control";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId } from "../../membership";
import { sameCapabilities } from "../../membership-shared";
import type { SourceAccess, SourceMemberAccess } from "../../migration/model";
import { ALL_CAPABILITIES, type Capability } from "../../types/identity";
import { addExistingMember } from "../members/assignment";
import { ensureTeamRoles } from "../roles/builtin-roles";
import { effectiveRoleCapabilities } from "../roles/member-capabilities";
import { createRole } from "../roles/role-editing";
import { setMemberAccess, type NodeGrantInput } from "../user-access";
import type { Report } from "./run-report";

type NodeKind = "project" | "environment" | "folder" | "app";

interface LandedNode {
  targetId: string;
  created: boolean;
}

interface LandedRole {
  id: string;
  name: string;
  // It reaches less here than at the source: a scope node or a capability did not come across.
  narrowed: boolean;
}

export interface AccessPlan {
  access: SourceAccess;
  roles: Map<string, LandedRole | null>;
  nodes: Map<string, LandedNode>;
  viewerRoleId: string;
}

const KIND_OF: Record<string, NodeKind> = {
  project: "project",
  environment: "environment",
  folder: "folder",
  app: "app",
};

// What this run landed, keyed by the source's id: a created node may carry its access, one already here may not.
async function landedNodes(runId: string): Promise<Map<string, LandedNode>> {
  const rows = await getDb()
    .select({
      sourceId: itemsTable.sourceId,
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
      outcome: itemsTable.outcome,
    })
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const out = new Map<string, LandedNode>();
  for (const r of rows) {
    const kind = KIND_OF[r.targetKind ?? ""];
    if (!kind || !r.sourceId || !r.targetId) continue;
    if (r.outcome !== "created" && r.outcome !== "skipped") continue;
    const key = `${kind}:${r.sourceId}`;
    if (out.get(key)?.created) continue;
    out.set(key, { targetId: r.targetId, created: r.outcome === "created" });
  }
  return out;
}

// Names this Deplo does not know are dropped, never expanded, so this only ever narrows.
function known(caps: string[]): { caps: Capability[]; dropped: boolean } {
  const all: string[] = ALL_CAPABILITIES;
  return {
    caps: ALL_CAPABILITIES.filter((c) => caps.includes(c)),
    dropped: caps.some((c) => !all.includes(c)),
  };
}

async function rolesHere(teamId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(teamRolesTable)
    .where(eq(teamRolesTable.teamId, teamId));
  const caps = rows.length
    ? await db
        .select()
        .from(teamRoleCapabilitiesTable)
        .where(
          inArray(
            teamRoleCapabilitiesTable.roleId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((r) => ({
    ...r,
    capabilities: effectiveRoleCapabilities(
      caps
        .filter((c) => c.roleId === r.id)
        .map((c) => c.capability as Capability),
      r.scoped,
    ),
  }));
}

export async function planAccess(
  runId: string,
  access: SourceAccess,
  report: Report,
): Promise<AccessPlan> {
  const teamId = await requireActiveTeamId();
  const builtins = await ensureTeamRoles(getDb(), teamId);
  const nodes = await landedNodes(runId);
  const roles = new Map<string, LandedRole | null>();
  const here = await rolesHere(teamId);
  const taken = new Set(here.map((h) => h.name.toLowerCase()));

  for (const r of access.roles) {
    if (r.builtinKey === "owner") {
      const id = builtins.get("owner");
      roles.set(r.id, id ? { id, name: "Owner", narrowed: false } : null);
      continue;
    }
    const { caps, dropped } = known(r.capabilities);
    const wanted = effectiveRoleCapabilities(caps, r.scoped);
    const same = !r.scoped
      ? here.find(
          (h) =>
            !h.scoped &&
            sameCapabilities(h.capabilities, wanted) &&
            (h.name.toLowerCase() === r.name.toLowerCase() ||
              (r.builtinKey !== null && h.builtinKey === r.builtinKey)),
        )
      : undefined;
    if (same) {
      roles.set(r.id, { id: same.id, name: same.name, narrowed: dropped });
      continue;
    }
    const scope = r.scope && {
      projectIds: mapIds(nodes, "project", r.scope.projectIds),
      environmentIds: mapIds(nodes, "environment", r.scope.environmentIds),
      folderIds: mapIds(nodes, "folder", r.scope.folderIds),
      appIds: mapIds(nodes, "app", r.scope.appIds),
    };
    const lost =
      r.scope !== null &&
      scope !== null &&
      scope.projectIds.length +
        scope.environmentIds.length +
        scope.folderIds.length +
        scope.appIds.length <
        r.scope.projectIds.length +
          r.scope.environmentIds.length +
          r.scope.folderIds.length +
          r.scope.appIds.length;
    const name = taken.has(r.name.toLowerCase())
      ? `${r.name} (imported)`
      : r.name;
    try {
      // The same guards as Settings: nobody authors a role beyond what they hold, or scoped wider than they reach.
      const created = await createRole({
        name,
        description: r.description,
        capabilities: caps,
        requireTwoFactor: r.requireTwoFactor,
        scope: r.scoped ? scope : null,
      });
      taken.add(name.toLowerCase());
      roles.set(r.id, { id: created.id, name, narrowed: dropped || lost });
      await report.add({
        sourceKind: "role",
        sourceId: r.id,
        sourceName: r.name,
        outcome: "created",
        targetKind: "role",
        targetId: created.id,
        message:
          [
            name !== r.name
              ? `This team already had a different role called ${r.name}, so it came across as ${name}.`
              : null,
            lost
              ? "Some of what it reached on {panel} did not come across, so here it reaches only what did."
              : null,
            dropped
              ? "Some of its permissions do not exist in this Deplo and were left out."
              : null,
          ]
            .filter(Boolean)
            .join(" ") || null,
      });
    } catch (e) {
      roles.set(r.id, null);
      await report.add({
        sourceKind: "role",
        sourceId: r.id,
        sourceName: r.name,
        outcome: "failed",
        targetKind: "role",
        message: `The ${r.name} role could not be created here: ${
          e instanceof Error ? e.message : "Deplo refused it."
        }`,
      });
    }
  }
  const viewerRoleId = builtins.get("viewer");
  if (!viewerRoleId) throw new Error("This team has no Viewer role.");
  return { access, roles, nodes, viewerRoleId };
}

function mapIds(
  nodes: Map<string, LandedNode>,
  kind: NodeKind,
  ids: string[],
): string[] {
  return ids.flatMap((id) => {
    const n = nodes.get(`${kind}:${id}`);
    return n?.created ? [n.targetId] : [];
  });
}

function described(m: SourceMemberAccess, plan: AccessPlan): string {
  const role = plan.access.roles.find((r) => r.id === m.roleId);
  const nodes = m.grants.length;
  return [
    role ? `the ${role.name} role` : "their own set of permissions",
    nodes > 0
      ? `their own access to ${nodes} folder${nodes === 1 ? "" : "s"}, project${nodes === 1 ? "" : "s"} or app${nodes === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" and ");
}

export function accessOfPerson(
  plan: AccessPlan,
  email: string,
): SourceMemberAccess | undefined {
  return plan.access.members.find((m) => m.email.toLowerCase() === email);
}

// Least privilege first: they join able to see, and only one guarded write gives them what they had.
export async function landMemberAccess(
  plan: AccessPlan,
  person: { email: string; name: string },
  userId: string,
): Promise<{ restored: boolean; message: string }> {
  await addExistingMember({ userId, role: "viewer", capabilities: ["view"] });
  const m = accessOfPerson(plan, person.email);
  const who = `${person.name || person.email} (${person.email})`;
  const viewOnly = (why: string) => ({
    restored: false,
    message: `${who} joined able to view only: ${why} On {panel} they had ${m ? described(m, plan) : "access this Deplo was not told about"}. Give them that in Members.`,
  });
  if (!m) return viewOnly("{panel} did not say what they could do.");

  const role = m.roleId
    ? plan.roles.get(m.roleId)
    : { id: plan.viewerRoleId, name: "Viewer", narrowed: false };
  if (!role) return viewOnly("their role could not be created here.");

  const grants: NodeGrantInput[] = [];
  let narrowed = role.narrowed;
  for (const g of m.grants) {
    const node = plan.nodes.get(`${g.kind}:${g.nodeId}`);
    if (!node) continue;
    if (!node.created || g.kind === "environment")
      return viewOnly(
        g.kind === "environment"
          ? "access to a single environment cannot be given here yet."
          : "part of their access was on something that was already here.",
      );
    const { caps, dropped } = known(g.capabilities);
    narrowed ||= dropped;
    grants.push({
      ...(g.kind === "project" ? { projectIds: [node.targetId] } : {}),
      ...(g.kind === "folder" ? { folderIds: [node.targetId] } : {}),
      ...(g.kind === "app" ? { appIds: [node.targetId] } : {}),
      capabilities: caps,
    });
  }
  const own = m.customCapabilities || !m.roleId ? known(m.capabilities) : null;
  narrowed ||= own?.dropped ?? false;
  try {
    await setMemberAccess({
      userId,
      roleId: role.id,
      granular: m.granular,
      grants,
      capabilities: own?.caps,
    });
  } catch (e) {
    return viewOnly(
      `${e instanceof Error ? e.message.replace(/\.?$/, ".") : "Deplo refused it."}`,
    );
  }
  if (narrowed)
    return {
      restored: false,
      message: `${who} joined with the ${role.name} role, but some of their access on {panel} did not come across. Check it in Members.`,
    };
  return {
    restored: true,
    message: `Added to the team with the ${role.name} role${grants.length > 0 ? ` and their own access to ${grants.length} folder(s), project(s) or app(s)` : ""}, as on {panel}.`,
  };
}

export function inviteNote(
  plan: AccessPlan,
  person: { email: string; name: string },
): string {
  const m = accessOfPerson(plan, person.email);
  return `${person.name || person.email} (${person.email}) joins able to view only once they register. On {panel} they had ${m ? described(m, plan) : "access this Deplo was not told about"}. Give them that in Members after they join.`;
}

// A private folder is the owner's: one that now belongs to someone else is named, so it can be shared back.
export async function folderOwnerNotes(
  plan: AccessPlan,
  names: Map<string, string>,
): Promise<string[]> {
  const me = (await getCurrentUser())?.email?.toLowerCase() ?? "";
  return plan.access.folderOwners.flatMap(({ folderId, email }) => {
    const node = plan.nodes.get(`folder:${folderId}`);
    const owner = email.toLowerCase();
    if (!node?.created || owner === me) return [];
    return [
      `${names.get(owner) || owner} (${owner}) owned a folder on {panel} that is yours here, so they cannot see it until you share it with them.`,
    ];
  });
}

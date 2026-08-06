"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Check,
  Crown,
  FolderTree,
  Link2,
  Loader2,
  PenLine,
  ShieldCheck,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { RoleSelect } from "@/components/members/role-select";
import { PermissionPicker } from "@/components/settings/permission-picker";
import {
  ScopePicker,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { gqlAction } from "@/lib/graphql-client";
import { NODE_GRANTABLE_CAPABILITIES, sameCapabilities } from "@/lib/membership-shared";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import type { MemberDTO } from "@/lib/data/members";
import type { TeamRoleDTO } from "@/lib/data/roles";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { TeamRoleOption, UserTeamAccessDTO } from "@/lib/data/user-access";

/**
 * One member's access, as three tabs over one form.
 *
 * ONE form and one Save, deliberately: the role lives on Permissions and decides
 * what Access inherits, so two independent saves would let an admin stage a role
 * change on one tab while the other still shows an inheritance that is already
 * stale.
 *
 * Which forces one implementation rule: Radix unmounts an inactive panel, so
 * EVERY piece of editable state lives here and the panels are presentational.
 * Hold it anywhere else and switching tabs silently discards the edit.
 *
 * The inherited/overridden problem is solved by rendering the SAME control in
 * both states — disabled when it inherits, showing the role's own values — with
 * a badge saying which one you are looking at. Two things can only be told apart
 * when they have the same shape.
 */

const TABS = ["permissions", "access", "activity"] as const;
type TabId = (typeof TABS)[number];

export function MemberDetailTabs({
  member,
  access,
  roles,
  tree,
  canAssignOwner,
}: {
  member: MemberDTO;
  access: UserTeamAccessDTO;
  roles: TeamRoleOption[];
  tree: ScopeTreeTeam[];
  canAssignOwner: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  const active: TabId = TABS.includes(params.get("tab") as TabId)
    ? (params.get("tab") as TabId)
    : "permissions";

  function selectTab(next: string) {
    const q = new URLSearchParams(params.toString());
    // The default tab drops the parameter: flipping between tabs is not
    // navigation the back button should have to walk through, so replace.
    if (next === TABS[0]) q.delete("tab");
    else q.set("tab", next);
    const s = q.toString();
    router.replace(s ? `?${s}` : "?", { scroll: false });
  }

  const role = roles.find((r) => r.id === access.roleId) ?? null;
  const initial = React.useMemo(
    () => ({
      roleId: access.roleId,
      // What they HAVE, not the stored mode flag. A member can hold grants with
      // `granular` false — the folder Share dialog writes the rows and never
      // touches the flag — and seeding from the flag meant an admin who only
      // changed the role saved `grants: []`, silently deleting every share.
      granular: access.granular || access.nodes.length > 0,
      selection: toSelection(access.nodes),
      groups: groupNodes(access.nodes),
    }),
    [access],
  );

  const [roleId, setRoleId] = React.useState<string | null>(initial.roleId);
  const [granular, setGranular] = React.useState(initial.granular);
  const [selection, setSelection] = React.useState<ScopeSelection>(
    initial.selection,
  );
  // One entry per distinct capability set the member already holds. Flattening
  // them to the first node's set is only correct when the admin authored all of
  // them in this session; for anyone with two shares at different levels it
  // silently levelled the lot.
  const [groups, setGroups] = React.useState<NodeGroup[]>(initial.groups);
  // The picker edits the FIRST group, which is the only one this page authors.
  const caps = groups[0]?.capabilities ?? ["view"];
  const setCaps = (next: Capability[]) =>
    setGroups((prev) =>
      prev.length === 0
        ? [{ capabilities: next, nodeIds: [] }]
        : [{ ...prev[0], capabilities: next }, ...prev.slice(1)],
    );

  const ticked =
    selection.projectIds.length +
    selection.folderIds.length +
    selection.appIds.length;
  const dirty =
    roleId !== initial.roleId ||
    granular !== initial.granular ||
    (granular &&
      (!sameSelection(selection, initial.selection) ||
        !sameCapabilities(caps, initial.groups[0]?.capabilities ?? ["view"])));

  // The founder's crown is immutable to everyone, and nobody edits their own
  // access. Both are refused server-side; saying so here spares a toast that
  // arrives after the click.
  const lockReason = access.isFounder
    ? "The team's primary owner. Their access can't be changed by anyone, and ownership moves by transferring the team."
    : null;
  const readOnly = lockReason != null;
  const emptyTicked = granular && ticked > 0 && caps.filter((c) => c !== "view").length === 0;
  const blocked = readOnly || !roleId || emptyTicked;

  function save() {
    if (blocked || !roleId) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($input: SetMemberAccessInput!) {
          setMemberAccess(input: $input) { teamId }
        }`,
        {
          input: {
            userId: member.userId,
            roleId,
            granular,
            // One payload: every ticked node carries the same set, which is what
            // this page lets an admin say. Different sets per node are the
            // folder Share dialog's job, and this page shows those rather than
            // rewriting them.
            grants: granular ? buildGrants(selection, groups) : [],
          },
        },
      );
      if (res.ok) {
        toast.success(`Saved @${member.username}'s access`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar className="size-10">
            <AvatarFallback
              style={{ backgroundColor: member.avatarColor, color: "#000" }}
            >
              {member.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                @{member.username}
              </h1>
              {member.roleName && (
                <Badge variant="outline">{member.roleName}</Badge>
              )}
              {member.isPrimaryOwner && (
                <Badge variant="secondary" className="gap-1">
                  <Crown className="size-3" />
                  Primary owner
                </Badge>
              )}
              {member.isInstanceAdmin && (
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="size-3" />
                  Instance admin
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {member.name && member.name !== member.username
                ? `${member.name} · `
                : ""}
              joined {timeAgo(member.createdAt)}
            </p>
          </div>
        </div>
        {lockReason && (
          <p className="text-sm text-muted-foreground">{lockReason}</p>
        )}
      </header>

      <Tabs value={active} onValueChange={selectTab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="permissions">
            Permissions
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="access">Access</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="activity">Activity</UnderlineTabsTrigger>
        </UnderlineTabsList>

        <TabsContent value="permissions" className="space-y-4 pt-4">
          <Card>
            <CardContent className="pt-6">
              {/* The founder's row is read-only, and RoleSelect has no
                  disabled state of its own: not rendering the picker is the
                  honest version of "there is nothing to choose here". */}
              {readOnly ? (
                <p className="text-sm text-muted-foreground">
                  Role: {member.roleName ?? "Custom"}
                </p>
              ) : (
                <RoleSelect
                  roles={roles as unknown as TeamRoleDTO[]}
                  value={roleId}
                  onChange={setRoleId}
                  canAssignOwner={canAssignOwner}
                  isCustom={access.roleId == null}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="access" className="space-y-4 pt-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <OverrideRow
                title="Per-node overrides"
                description="Give them a different set inside single projects, folders or apps, with their role still applying everywhere else."
                roleName={role?.name ?? "current"}
                on={granular}
                onChange={setGranular}
                disabled={readOnly}
              />
              {granular && (
                <>
                  <ScopePicker
                    tree={tree}
                    selection={selection}
                    onChange={setSelection}
                    disabled={readOnly}
                    teamPickable={false}
                    title="Where"
                    info="Tick a project, a folder or an app. Everything under a ticked node follows it."
                    emptyNote="This team has nothing to scope to yet."
                    footer={
                      <p className="text-xs text-muted-foreground">
                        {ticked === 0 ? (
                          <>
                            <span className="font-medium text-foreground">
                              Nothing ticked.
                            </span>{" "}
                            Their {role?.name ?? "role"} applies everywhere in
                            this team.
                          </>
                        ) : (
                          <>
                            <span className="font-medium text-foreground">
                              {ticked} node{ticked === 1 ? "" : "s"}.
                            </span>{" "}
                            Inside them this set replaces the role and can grant
                            more than it does, so lowering the role won&apos;t
                            lower it here. To take it away, untick the node or
                            remove them from the team.
                          </>
                        )}
                      </p>
                    }
                  />
                  {ticked > 0 && (
                    <PermissionPicker
                      capabilities={caps}
                      onChange={setCaps}
                      disabled={readOnly}
                      hint="What they may do inside the ticked nodes. Permissions that only work team-wide can't be given on a node, so they aren't offered."
                      muted={{
                        caps: ALL_CAPABILITIES.filter(
                          (c) => !NODE_GRANTABLE_CAPABILITIES.includes(c),
                        ),
                        reason:
                          "This one only works team-wide, so it can't be given on a single project, folder or app.",
                      }}
                    />
                  )}
                  {emptyTicked && (
                    <p className="text-xs text-destructive">
                      Pick at least one permission, or untick the nodes: an
                      override that grants nothing leaves the role applying
                      there, which is the opposite of what a tick says.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {access.nodes.length > 0 && (
            <Card>
              <CardContent className="space-y-2 pt-6">
                <h3 className="text-sm font-medium">Shared directly with them</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Folders and apps someone shared with them outside their role.
                </p>
                <ul className="divide-y divide-border/60 rounded-lg border border-border">
                  {access.nodes.map((n) => (
                    <li
                      key={`${n.kind}:${n.nodeId}`}
                      className="flex items-center gap-2 px-3 py-2 text-sm"
                    >
                      <FolderTree className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{n.name}</span>
                      <Badge variant="muted">
                        {n.capabilities.filter((c) => c !== "view").length}{" "}
                        permissions
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="activity" className="space-y-4 pt-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">
                Everything @{member.username} does in this team shows up in{" "}
                <Link
                  href="/activity"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Activity
                </Link>
                .
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty || pending || blocked}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {dirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      )}
    </form>
  );
}

/** The switch that says whether a control shows the role or this member's own. */
function OverrideRow({
  title,
  description,
  roleName,
  on,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  roleName: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          <Badge variant={on ? "warning" : "muted"} className="gap-1">
            {on ? <PenLine className="size-3" /> : <Link2 className="size-3" />}
            {on ? "Custom for this member" : `From the ${roleName} role`}
          </Badge>
          <InfoTip content="Editing the role changes it for everyone who holds it. This changes it for them alone." />
        </div>
        <p className={cn("mt-1 text-xs text-muted-foreground")}>{description}</p>
      </div>
      <Switch
        checked={on}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={title}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function toSelection(
  nodes: UserTeamAccessDTO["nodes"],
): ScopeSelection {
  return {
    teamIds: [],
    projectIds: nodes.filter((n) => n.kind === "project").map((n) => n.nodeId),
    folderIds: nodes.filter((n) => n.kind === "folder").map((n) => n.nodeId),
    appIds: nodes.filter((n) => n.kind === "app").map((n) => n.nodeId),
  };
}

/**
 * The set the ticked nodes carry. This page writes ONE set across them, so it
 * seeds from the first node — a member whose nodes disagree got them from the
 * folder Share dialog, which is the surface that can say different things in
 * different places.
 */
export interface NodeGroup {
  capabilities: Capability[];
  nodeIds: string[];
}

/**
 * The member's existing grants, grouped by the set they carry. Two shares at
 * different levels are two groups, and they stay two through a save.
 */
export function groupNodes(nodes: UserTeamAccessDTO["nodes"]): NodeGroup[] {
  const by = new Map<string, NodeGroup>();
  for (const n of nodes) {
    const key = [...n.capabilities].sort().join(",");
    const g = by.get(key) ?? { capabilities: n.capabilities, nodeIds: [] };
    g.nodeIds.push(n.nodeId);
    by.set(key, g);
  }
  return [...by.values()];
}

/**
 * The payload: every ticked node, carrying the set it already had, plus the
 * picker's set for the ones the admin just added.
 *
 * The write is a whole-set replace, so a node left out is a node revoked — which
 * is why this rebuilds from the CURRENT selection rather than from the groups
 * alone, and why a node whose group is gone falls back to what the picker shows.
 */
export function buildGrants(
  selection: ScopeSelection,
  groups: NodeGroup[],
): {
  projectIds: string[];
  folderIds: string[];
  appIds: string[];
  capabilities: Capability[];
}[] {
  const setOf = new Map(groups.flatMap((g) => g.nodeIds.map((id) => [id, g])));
  const authored = groups[0]?.capabilities ?? ["view"];
  const kinds: [UserTeamAccessDTO["nodes"][number]["kind"], string[]][] = [
    ["project", selection.projectIds],
    ["folder", selection.folderIds],
    ["app", selection.appIds],
  ];
  const out = new Map<
    string,
    { projectIds: string[]; folderIds: string[]; appIds: string[]; capabilities: Capability[] }
  >();
  for (const [kind, ids] of kinds) {
    for (const id of ids) {
      const caps = setOf.get(id)?.capabilities ?? authored;
      const key = [...caps].sort().join(",");
      const entry =
        out.get(key) ?? { projectIds: [], folderIds: [], appIds: [], capabilities: caps };
      if (kind === "project") entry.projectIds.push(id);
      else if (kind === "folder") entry.folderIds.push(id);
      else entry.appIds.push(id);
      out.set(key, entry);
    }
  }
  return [...out.values()];
}

function sameSelection(a: ScopeSelection, b: ScopeSelection): boolean {
  const same = (x: string[], y: string[]) =>
    x.length === y.length && [...x].sort().join() === [...y].sort().join();
  return (
    same(a.projectIds, b.projectIds) &&
    same(a.folderIds, b.folderIds) &&
    same(a.appIds, b.appIds)
  );
}

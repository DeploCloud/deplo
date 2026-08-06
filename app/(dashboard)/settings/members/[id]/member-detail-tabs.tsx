"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Check,
  Crown,
  FolderTree,
  Loader2,
  ShieldCheck,
  UserCog,
  UserMinus,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { RoleSelect } from "@/components/members/role-select";
import { PermissionPicker } from "@/components/settings/permission-picker";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  ScopePicker,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { gqlAction } from "@/lib/graphql-client";
import { NODE_GRANTABLE_CAPABILITIES, sameCapabilities } from "@/lib/membership-shared";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import type { MemberDTO } from "@/lib/data/members";
import type { TeamRoleDTO } from "@/lib/data/roles";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { UserTeamAccessDTO } from "@/lib/data/user-access";

/**
 * Everything about one member OF THIS TEAM, in one place: role, per-node access,
 * and removal from the team. The roster tiles link straight here — there is no
 * menu and no modal in between, so this page is the only surface that acts on a
 * member.
 *
 * The person's instance-wide account is deliberately NOT here: it is not
 * team-scoped, so it lives on Settings → Users and the header links an instance
 * admin straight at that account's editor (`?user=<id>` opens it on arrival).
 *
 * The role and the per-node overrides are ONE tab and ONE Save, deliberately:
 * the role is the base the overrides carve out of, so splitting them let an
 * admin stage a role change on one tab while the other still showed an
 * inheritance that was already stale.
 *
 * Which forces one implementation rule: Radix unmounts an inactive panel, so
 * EVERY piece of editable state lives here and the panels are presentational.
 * Hold it anywhere else and switching tabs silently discards the edit.
 */

const TABS = ["permissions", "activity"] as const;
type TabId = (typeof TABS)[number];

export function MemberDetailTabs({
  member,
  access,
  roles,
  tree,
  canAssignOwner,
  isSelf,
  canManageAccount,
}: {
  member: MemberDTO;
  access: UserTeamAccessDTO;
  roles: TeamRoleDTO[];
  tree: ScopeTreeTeam[];
  canAssignOwner: boolean;
  /** The viewer is looking at their own membership. */
  isSelf: boolean;
  /** Instance admin — the link to this person's global account is theirs alone. */
  canManageAccount: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  const tab = params.get("tab") as TabId;
  const active: TabId = TABS.includes(tab) ? tab : "permissions";
  // Only the editing tab carries the Save — Activity has nothing to save.
  const onTeamTab = active === "permissions";

  function selectTab(next: string) {
    const q = new URLSearchParams(params.toString());
    // The default tab drops the parameter: flipping between tabs is not
    // navigation the back button should have to walk through, so replace.
    if (next === TABS[0]) q.delete("tab");
    else q.set("tab", next);
    const s = q.toString();
    // The native History API, NOT `router.replace`: both panels are already on
    // the client, and a router navigation re-runs this whole page on the server
    // (the member, the roles, the team's scope tree) to change one query
    // parameter. Clicking between tabs faster than those renders finish left a
    // request per click queued behind the last, and the page got slower the more
    // you clicked. `useSearchParams` still sees this, so `active` follows.
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  }

  const initial = React.useMemo(
    () => ({
      roleId: access.roleId,
      // What they HAVE, not the stored mode flag. A member can hold grants with
      // `granular` false — the folder Share dialog writes the rows and never
      // touches the flag — and seeding from the flag meant an admin who only
      // changed the role saved `grants: []`, silently deleting every share.
      selection: toSelection(access.nodes),
      groups: groupNodes(access.nodes),
    }),
    [access],
  );

  const [roleId, setRoleId] = React.useState<string | null>(initial.roleId);
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
  // The overrides ARE the ticked nodes: nothing ticked means the role applies
  // everywhere, which is what "off" used to mean. One control, not two saying
  // the same thing — a mode switch left on with nothing ticked said nothing.
  const granular = ticked > 0;
  const role = roles.find((r) => r.id === roleId) ?? null;
  const dirty =
    roleId !== initial.roleId ||
    !sameSelection(selection, initial.selection) ||
    (granular &&
      !sameCapabilities(caps, initial.groups[0]?.capabilities ?? ["view"]));

  // Who this viewer may not act on. All three are refused server-side; saying so
  // here spares a toast that arrives after the click, and is why the roster can
  // link every tile without pre-judging what you will find.
  const lockReason = access.isFounder
    ? "The team's primary owner. Their access can't be changed by anyone, and ownership moves by transferring the team."
    : isSelf
      ? "Your own membership. Another admin has to change it for you."
      : member.role === "owner" && !canAssignOwner
        ? "An owner's access can only be changed by another owner."
        : null;
  const readOnly = lockReason != null;
  // Removal follows the same rule as editing: the locks above are exactly the
  // people `removeMember` refuses.
  const canRemove = !readOnly;
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
    <div className="space-y-6">
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
          {/* The account is instance-wide, so it is edited where every account
              is — this jumps there with their editor already open. */}
          {canManageAccount && (
            <Button asChild variant="outline" size="sm" className="ml-auto">
              <Link href={`/settings/users?user=${member.userId}`}>
                <UserCog className="size-4" />
                Manage account
              </Link>
            </Button>
          )}
        </div>
        {lockReason && (
          <p className="text-sm text-muted-foreground">{lockReason}</p>
        )}
      </header>

      <Tabs value={active} onValueChange={selectTab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="permissions">
            Role &amp; permissions
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="activity">Activity</UnderlineTabsTrigger>
        </UnderlineTabsList>

        {/* Everything team-scoped, one form, one Save. */}
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
        <TabsContent value="permissions" className="space-y-4 pt-4">
          {/* The overrides sit ABOVE the role and are always on screen: they are
              the only reason this member's access differs from everyone else's
              with the same role, and behind a switch an admin had to flip
              something to find out whether there were any. Ticking nothing IS
              "no overrides" — the mode switch that used to say it was a second
              control for one decision. */}
          <Card>
            <CardContent className="space-y-4 pt-6">
              <ScopePicker
                tree={tree}
                selection={selection}
                onChange={setSelection}
                disabled={readOnly}
                teamPickable={false}
                title="Per-node overrides"
                info="Tick a project, a folder or an app to give them a different set of permissions inside it, with their role still applying everywhere else. Everything under a ticked node follows it."
                emptyNote="This team has nothing to scope to yet."
                footer={
                  <p className="text-xs text-muted-foreground">
                    {ticked === 0 ? (
                      <>
                        <span className="font-medium text-foreground">
                          Nothing ticked.
                        </span>{" "}
                        Their {role?.name ?? "role"} applies everywhere in this
                        team.
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-foreground">
                          {ticked} node{ticked === 1 ? "" : "s"}.
                        </span>{" "}
                        Inside them this set replaces the role and can grant more
                        than it does, so lowering the role won&apos;t lower it
                        here. To take it away, untick the node or remove them
                        from the team.
                      </>
                    )}
                  </p>
                }
              />
              {granular && (
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
                  Pick at least one permission, or untick the nodes: an override
                  that grants nothing leaves the role applying there, which is
                  the opposite of what a tick says.
                </p>
              )}
            </CardContent>
          </Card>

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
                  roles={roles}
                  value={roleId}
                  onChange={setRoleId}
                  canAssignOwner={canAssignOwner}
                  isCustom={access.roleId == null}
                />
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

          {canRemove && (
            <Card className="border-destructive/40">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Remove from team</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    They lose access to this team. Their account and other teams
                    are untouched.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmRemove(true)}
                >
                  <UserMinus className="size-4" />
                  Remove
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

          {!readOnly && onTeamTab && (
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

      <ConfirmAction
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove @${member.username} from the team?`}
        description="They lose access to this team's apps and resources right away. Their account, and every other team they are in, is untouched — add them back at any time."
        confirmLabel="Remove member"
        successMessage="Member removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($userId: String!) { removeMember(userId: $userId) }`,
            { userId: member.userId },
          );
          if (res.ok) {
            router.push("/settings/members");
            router.refresh();
          }
          return res;
        }}
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

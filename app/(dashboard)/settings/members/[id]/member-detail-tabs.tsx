"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Activity as ActivityIcon,
  Check,
  Crown,
  Loader2,
  Lock,
  ShieldCheck,
  UserCog,
  UserMinus,
} from "lucide-react";

import { UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { RoleSelect } from "@/components/members/role-select";
import { PermissionPicker } from "@/components/settings/permission-picker";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EmptyState } from "@/components/shared/empty-state";
import { AccessDeltaBadge } from "@/components/members/access-delta-badge";
import {
  ScopePicker,
  coversEverything,
  everythingSelection,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { gqlAction } from "@/lib/graphql-client";
import {
  NODE_GRANTABLE_CAPABILITIES,
  PROJECT_SCOPED_CAPABILITIES,
  accessDelta,
  boundedBy,
  sameCapabilities,
} from "@/lib/membership-shared";
import { ALL_CAPABILITIES, type Activity, type Capability } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import {
  ActivityTimeline,
  toActivityItem,
} from "@/components/activity/activity-timeline";
import type { MemberDTO } from "@/lib/data/members";
import type { TeamRoleDTO } from "@/lib/data/roles";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { UserTeamAccessDTO } from "@/lib/data/user-access";
import { titleClass } from "@/components/shared/page-header";

/**
 * Everything about one member OF THIS TEAM, in one place: their role, where they
 * can work, what they can do there, and removal from the team. Hold it anywhere
 * else and switching tabs silently discards the edit.
 */

const TABS = ["permissions", "activity", "advanced"] as const;
type TabId = (typeof TABS)[number];

export function MemberDetailTabs({
  member,
  access,
  roles,
  tree,
  canAssignOwner,
  isSelf,
  canManageAccount,
  activity,
  viewerIsPrimaryOwner,
  viewerTwoFactorEnabled,
}: {
  member: MemberDTO;
  access: UserTeamAccessDTO;
  roles: TeamRoleDTO[];
  tree: ScopeTreeTeam[];
  canAssignOwner: boolean;
  /** The viewer is looking at their own membership. */
  isSelf: boolean;
  /** Instance admin - the link to this person's global account is theirs alone. */
  canManageAccount: boolean;
  /** Their last few events in this team, newest first. */
  activity: Activity[];
  /** The VIEWER holds the crown, so the team is theirs to hand over. */
  viewerIsPrimaryOwner: boolean;
  /** The VIEWER's own 2FA, which decides whether the transfer asks for a code. */
  viewerTwoFactorEnabled: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [confirmTransfer, setConfirmTransfer] = React.useState(false);
  const [transferPassword, setTransferPassword] = React.useState("");
  const [transferCode, setTransferCode] = React.useState("");

  const tab = params.get("tab") as TabId;
  const active: TabId = TABS.includes(tab) ? tab : "permissions";
  // Only the editing tab carries the Save - Activity has nothing to save.
  const onTeamTab = active === "permissions";

  function selectTab(next: string) {
    const q = new URLSearchParams(params.toString());
    // The default tab drops the parameter: flipping between tabs is not
    // navigation the back button should have to walk through, so replace.
    if (next === TABS[0]) q.delete("tab");
    else q.set("tab", next);
    const s = q.toString();
    // The native History API, NOT `router.replace`: both panels are already on the
    // client, and a router navigation re-runs this whole page on the server (the
    // member, the roles, the team's scope tree) to change one query parameter.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  const savedRole = roles.find((r) => r.id === access.roleId) ?? null;
  const initial = React.useMemo(
    () => ({
      roleId: access.roleId,
      // Where they REACH today: their own nodes when they have a set of their own,
      // otherwise their role's reach plus whatever was shared with them on top.
      selection: access.granular
        ? toSelection(access.nodes)
        : union(reachOf(savedRole, tree), toSelection(access.nodes)),
      // The live set on their membership: identical to the role's for everyone
      // who simply follows one.
      capabilities: access.baseCapabilities,
      groups: groupNodes(access.nodes),
    }),
    [access, savedRole, tree],
  );

  const [roleId, setRoleId] = React.useState<string | null>(initial.roleId);
  const [selection, setSelection] = React.useState<ScopeSelection>(
    initial.selection,
  );
  const [caps, setCaps] = React.useState<Capability[]>(initial.capabilities);
  // One entry per distinct set they already hold on a node, so an admin who only
  // moves the ticks around doesn't flatten two folder shares made at different
  // levels onto one set.
  const [groups] = React.useState<NodeGroup[]>(initial.groups);

  const role = roles.find((r) => r.id === roleId) ?? null;
  const roleReach = React.useMemo(() => reachOf(role, tree), [role, tree]);
  const roleCaps = React.useMemo(() => effectiveCapabilities(role), [role]);
  // A role limited to an ENVIRONMENT can't be redrawn here: a node grant has no
  // environment rung, so the picker would show the ticks it can express and drop the
  // rest on save.
  const reachEditable = (role?.scope?.environmentIds.length ?? 0) === 0;

  /** Picking a role re-fills both editors from it - it is the new base. */
  function pickRole(id: string) {
    const next = roles.find((r) => r.id === id) ?? null;
    setRoleId(id);
    setSelection(reachOf(next, tree));
    setCaps(effectiveCapabilities(next));
  }

  const ticked = tickedIds(selection);
  // Do the ticks still include everywhere the role reaches? When they don't,
  // THEY are this person's reach from now on and the role stops answering for
  // them, which is the one act on this page that takes a place away.
  const covers = coversRoleReach(selection, role, tree);
  const granular = reachEditable && !covers;
  // Ticks the role doesn't reach: what an admin added here, plus every folder
  // somebody shared with them. Written even while the role still supplies the
  // reach, or saving this page would revoke those shares.
  const extra = subtract(selection, roleReach);
  const delta = accessDelta({
    capabilities: caps,
    roleCapabilities: roleCaps,
    granular,
    nodeIds: ticked,
    roleNodeIds: role?.scope ? scopeIds(role.scope) : null,
  });

  const dirty =
    roleId !== initial.roleId ||
    !sameSelection(selection, initial.selection) ||
    !sameCapabilities(caps, initial.capabilities);

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
  // Only the crown hands the crown on, and it can go to anybody in the team: the
  // transfer puts them on the Owner role itself, so there is no rank to arrange
  // first (lib/data/team-ownership.ts).
  const canTransfer = viewerIsPrimaryOwner && !isSelf && !member.isPrimaryOwner;
  // What the ticked nodes can actually carry.
  const onNodes = boundedBy(caps, NODE_GRANTABLE_CAPABILITIES);
  // They don't reach the whole team - by their role's doing or by an admin's.
  // Same question the server asks before it bounds their set, so a tick the
  // save would drop is struck through here instead of silently disappearing.
  const reachLimited = granular || role?.scope != null;
  const nothingTicked = ticked.length === 0 && tree.length > 0;
  const nothingAllowed =
    (reachLimited ? onNodes : caps).filter((c) => c !== "view").length === 0;
  const blocked = readOnly || !roleId || nothingTicked || nothingAllowed;
  // A disabled Save with no reason is the same as a broken one. All four reasons read
  // as one warning at the top of the editor, not one line per card: an admin sees it
  // while editing, instead of after clicking a button that does nothing.
  const blockedReason = readOnly
    ? null
    : !roleId
      ? "Pick a role to save."
      : nothingTicked
        ? "Tick at least one place under Access."
        : !nothingAllowed
          ? null
          : reachLimited
            ? "Their permissions only work on a whole team. Use Select all under Access, or tick one that works on a single app, like Deploy apps."
            : "Pick at least one permission, or give them the Viewer role.";

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
            // Their reach when it is theirs; only what the role doesn't already
            // reach when it isn't, so a share survives a save that never touched
            // it.
            grants: buildGrants(
              granular ? selection : extra,
              groups,
              onNodes,
              !sameCapabilities(caps, initial.capabilities),
            ),
            // Their own set. Identical to the role's until an admin changes it,
            // and the server compares the two to decide whether the role still
            // owns this membership's permissions.
            capabilities: caps,
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
          <UserAvatar
            name={member.name}
            username={member.username}
            avatarColor={member.avatarColor}
            avatarUrl={member.avatarUrl}
            size="xl"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className={titleClass.page}>@{member.username}</h1>
              {member.roleName && (
                <Badge variant="outline">{member.roleName}</Badge>
              )}
              {/* Live, not the stored verdict: while an admin edits, this says
                  what the Save is about to make true. */}
              <AccessDeltaBadge delta={delta} roleName={role?.name ?? null} />
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
              is - this jumps there with their editor already open. */}
          {canManageAccount && (
            <Button asChild variant="outline" size="sm" className="ml-auto">
              <Link href={`/settings/users?user=${member.userId}`}>
                <UserCog className="size-4" />
                Manage account
              </Link>
            </Button>
          )}
        </div>
      </header>

      <Tabs value={active} onValueChange={selectTab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="permissions">
            Role &amp; permissions
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="activity">Activity</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="advanced">Advanced</UnderlineTabsTrigger>
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
            {/* Why nothing on this tab can be edited, above the things that
                can't be: it belongs to the editors, not to the person. */}
            {lockReason && (
              <div className="flex items-center gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
                <Lock className="size-5 shrink-0 text-[var(--warning)]" />
                <p className="text-sm">{lockReason}</p>
              </div>
            )}
            {/**
             * The role comes first: the two editors below are filled from it, so picking
             * another one re-fills them.
             */}
            {!access.isFounder && (
              <Card>
                <CardContent className="pt-6">
                  {/* A locked row has no picker: RoleSelect has no disabled
                      state of its own, and not rendering it is the honest
                      version of "there is nothing to choose here". */}
                  {readOnly ? (
                    <p className="text-sm text-muted-foreground">
                      Role: {member.roleName ?? "Custom"}
                    </p>
                  ) : (
                    <RoleSelect
                      roles={roles}
                      value={roleId}
                      onChange={pickRole}
                      canAssignOwner={canAssignOwner}
                      isCustom={access.roleId == null}
                    />
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="pt-6">
                <ScopePicker
                  tree={tree}
                  selection={selection}
                  onChange={setSelection}
                  disabled={readOnly || !reachEditable}
                  teamPickable={false}
                  info={
                    reachEditable
                      ? "Everywhere their role reaches is ticked. Untick what this one person shouldn't touch, or tick something extra to let them in. Everything under a ticked node follows it."
                      : `Set by their role: ${role?.name} is limited to specific environments, which can only be changed on the role.`
                  }
                  docs="team.limitedAccess"
                  emptyNote="This team has nothing to give access to yet."
                  notice={blockedReason}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 pt-6">
                <PermissionPicker
                  capabilities={caps}
                  onChange={setCaps}
                  disabled={readOnly}
                  hint="Filled in from their role. Untick to take something away from this one person, tick to give them extra - the role, and everyone else holding it, stays as it is."
                  muted={
                    reachLimited
                      ? {
                          caps: ALL_CAPABILITIES.filter(
                            (c) => !NODE_GRANTABLE_CAPABILITIES.includes(c),
                          ),
                          reason:
                            "They reach only part of the team, so this one has nothing to apply to.",
                        }
                      : undefined
                  }
                />
              </CardContent>
            </Card>
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
          {/* What they have actually done here, not a pointer to where it lives:
              the tab answering "what has this person been up to" with a sentence
              about another page was an empty state pretending to be content. */}
          {activity.length === 0 ? (
            <EmptyState
              icon={ActivityIcon}
              title="Nothing yet"
              description={`@${member.username} hasn't done anything in this team that gets logged.`}
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link href="/activity">Open Activity</Link>
                </Button>
              }
            />
          ) : (
            <Card>
              <CardContent className="space-y-4 pt-6">
                {/* The actor is this page, so the rows name only the event. */}
                <ActivityTimeline
                  variant="compact"
                  showActor={false}
                  items={activity.map(toActivityItem)}
                />
                <Button variant="outline" size="sm" className="w-full" asChild>
                  <Link href="/activity">Open Activity</Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>
        {/* The two actions that end a membership rather than shape it: they are
            not edits, they have no Save, and one of them hands the team over. */}
        <TabsContent value="advanced" className="space-y-4 pt-4">
          {canTransfer && (
            <Card className="border-destructive/40">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Transfer team ownership</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    @{member.username} gets the Owner role and becomes the
                    team&apos;s primary owner. You stay an owner, but only they
                    can hand it back.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmTransfer(true)}
                >
                  <Crown className="size-4" />
                  Transfer
                </Button>
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

          {!canTransfer && !canRemove && (
            <EmptyState
              icon={Lock}
              title="Nothing to do here"
              description={
                member.isPrimaryOwner
                  ? "The team's primary owner can't be removed. To hand the team over, open the owner you want to give it to and transfer it there."
                  : isSelf
                    ? "You can't remove yourself from the team. Another owner can."
                    : "This membership can't be removed."
              }
            />
          )}
        </TabsContent>
      </Tabs>

      {canTransfer && (
        <ConfirmAction
          open={confirmTransfer}
          onOpenChange={(v) => {
            setConfirmTransfer(v);
            if (!v) {
              setTransferPassword("");
              setTransferCode("");
            }
          }}
          title={`Make @${member.username} the primary owner?`}
          description={`@${member.username} gets the Owner role and full access to this team, and becomes the one person nobody here can remove, demote or edit. You stay an owner - they can take that away, and only they can hand the team back.`}
          confirmLabel="Transfer ownership"
          confirmText={member.username}
          successMessage="Team ownership transferred"
          extra={
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="transfer-password">Your password</Label>
                <Input
                  id="transfer-password"
                  type="password"
                  autoComplete="current-password"
                  value={transferPassword}
                  onChange={(e) => setTransferPassword(e.target.value)}
                />
              </div>
              {/* Only when the account has a second factor: asking everyone for
                  a code they may not have is a dead end, not a guard. */}
              {viewerTwoFactorEnabled && (
                <div className="space-y-2">
                  <Label htmlFor="transfer-code">
                    Code from your authenticator app
                  </Label>
                  <Input
                    id="transfer-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    value={transferCode}
                    onChange={(e) => setTransferCode(e.target.value)}
                  />
                </div>
              )}
            </div>
          }
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation ($userId: String!, $password: String!, $code: String) {
                transferTeamOwnership(userId: $userId, password: $password, code: $code)
              }`,
              {
                userId: member.userId,
                password: transferPassword,
                code: transferCode || null,
              },
            );
            if (res.ok) router.refresh();
            return res;
          }}
        />
      )}

      <ConfirmAction
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove member?"
        description={`@${member.username} loses access to this team's apps and resources right away. Their account, and every other team they are in, is untouched - add them back at any time.`}
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

/** Where a role reaches, as ticks: everything when it isn't limited. */
function reachOf(
  role: TeamRoleDTO | null,
  tree: ScopeTreeTeam[],
): ScopeSelection {
  if (!role?.scope) return everythingSelection(tree);
  return {
    teamIds: [],
    projectIds: role.scope.projectIds,
    folderIds: role.scope.folderIds,
    appIds: role.scope.appIds,
  };
}

/**
 * What a role actually gives its holders: its authored set once its own reach has
 * clamped it, which is what `effectiveRoleCapabilities` writes onto every
 * membership.
 */
function effectiveCapabilities(role: TeamRoleDTO | null): Capability[] {
  if (!role) return ["view"];
  return role.scope
    ? boundedBy(role.capabilities, PROJECT_SCOPED_CAPABILITIES)
    : role.capabilities;
}

/**
 * Whether the ticks still include everywhere the role reaches. False means this
 * person's ticks ARE their reach from now on, so it is asked of the role's own
 * nodes rather than of a count.
 */
function coversRoleReach(
  selection: ScopeSelection,
  role: TeamRoleDTO | null,
  tree: ScopeTreeTeam[],
): boolean {
  if (!role?.scope) return coversEverything(tree, selection);
  const picked = new Set(tickedIds(selection));
  return scopeIds(role.scope).every((id) => picked.has(id));
}

const scopeIds = (scope: {
  projectIds: string[];
  environmentIds: string[];
  folderIds: string[];
  appIds: string[];
}) => [
  ...scope.projectIds,
  ...scope.environmentIds,
  ...scope.folderIds,
  ...scope.appIds,
];

const tickedIds = (s: ScopeSelection) => [
  ...s.projectIds,
  ...s.folderIds,
  ...s.appIds,
];

/** Everything ticked in either. */
function union(a: ScopeSelection, b: ScopeSelection): ScopeSelection {
  const merge = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    teamIds: [],
    projectIds: merge(a.projectIds, b.projectIds),
    folderIds: merge(a.folderIds, b.folderIds),
    appIds: merge(a.appIds, b.appIds),
  };
}

/** The ticks `a` has and `b` doesn't. */
function subtract(a: ScopeSelection, b: ScopeSelection): ScopeSelection {
  const less = (x: string[], y: string[]) => x.filter((id) => !y.includes(id));
  return {
    teamIds: [],
    projectIds: less(a.projectIds, b.projectIds),
    folderIds: less(a.folderIds, b.folderIds),
    appIds: less(a.appIds, b.appIds),
  };
}

function toSelection(nodes: UserTeamAccessDTO["nodes"]): ScopeSelection {
  return {
    teamIds: [],
    projectIds: nodes.filter((n) => n.kind === "project").map((n) => n.nodeId),
    folderIds: nodes.filter((n) => n.kind === "folder").map((n) => n.nodeId),
    appIds: nodes.filter((n) => n.kind === "app").map((n) => n.nodeId),
  };
}

/** The set one node carries. */
export interface NodeGroup {
  capabilities: Capability[];
  nodeIds: string[];
}

/**
 * The member's existing grants, grouped by the set they carry. Two shares at
 * different levels are two groups, and they stay two through a save that only
 * moved the ticks around.
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
 * The payload: every node in `selection`, carrying `authored` - except nodes that
 * already had a set of their own, which keep it unless the admin edited the
 * permission list (then one set applies everywhere, which is what editing it
 * says).
 */
export function buildGrants(
  selection: ScopeSelection,
  groups: NodeGroup[],
  authored: Capability[],
  capsEdited: boolean,
): {
  projectIds: string[];
  folderIds: string[];
  appIds: string[];
  capabilities: Capability[];
}[] {
  const setOf = new Map(groups.flatMap((g) => g.nodeIds.map((id) => [id, g])));
  const kinds: [UserTeamAccessDTO["nodes"][number]["kind"], string[]][] = [
    ["project", selection.projectIds],
    ["folder", selection.folderIds],
    ["app", selection.appIds],
  ];
  const out = new Map<
    string,
    {
      projectIds: string[];
      folderIds: string[];
      appIds: string[];
      capabilities: Capability[];
    }
  >();
  for (const [kind, ids] of kinds) {
    for (const id of ids) {
      const own = setOf.get(id)?.capabilities;
      const caps = own && !capsEdited ? own : authored;
      const key = [...caps].sort().join(",");
      const entry = out.get(key) ?? {
        projectIds: [],
        folderIds: [],
        appIds: [],
        capabilities: caps,
      };
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

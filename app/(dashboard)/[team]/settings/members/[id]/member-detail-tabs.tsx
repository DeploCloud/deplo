"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "@/lib/nav";
import Link from "@/components/ui/link";
import { toast } from "sonner";
import {
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
import { RevealInput } from "@/components/ui/password-field";
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
import { ScopePicker } from "@/components/settings/tokens/scope-picker/picker";
import {
  coversEverything,
  everythingSelection,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker/selection";
import { gqlAction } from "@/lib/graphql-client";
import {
  NODE_GRANTABLE_CAPABILITIES,
  PROJECT_SCOPED_CAPABILITIES,
  accessDelta,
  boundedBy,
  sameCapabilities,
} from "@/lib/membership-shared";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types/identity";
import { timeAgo } from "@/lib/utils";
import type { MemberDTO } from "@/lib/data/members/roster";
import type { TeamRoleDTO } from "@/lib/data/roles/role-list";
import type { ScopeTreeTeam } from "@/lib/data/tokens/scope-tree";
import type { UserTeamAccessDTO } from "@/lib/data/user-access";
import { titleClass } from "@/components/shared/page-header";

const TABS = ["permissions", "activity", "advanced"] as const;
type TabId = (typeof TABS)[number];

export function MemberDetailTabs({
  activity,
  member,
  access,
  roles,
  tree,
  canAssignOwner,
  isSelf,
  canManageAccount,
  viewerIsPrimaryOwner,
  viewerTwoFactorEnabled,
}: {
  activity: React.ReactNode;
  member: MemberDTO;
  access: UserTeamAccessDTO;
  roles: TeamRoleDTO[];
  tree: ScopeTreeTeam[];
  canAssignOwner: boolean;
  isSelf: boolean;
  canManageAccount: boolean;
  viewerIsPrimaryOwner: boolean;
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
  const onTeamTab = active === "permissions";

  function selectTab(next: string) {
    const q = new URLSearchParams(params.toString());
    if (next === TABS[0]) q.delete("tab");
    else q.set("tab", next);
    const s = q.toString();
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
      selection: access.granular
        ? toSelection(access.nodes)
        : union(reachOf(savedRole, tree), toSelection(access.nodes)),
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
  const [groups] = React.useState<NodeGroup[]>(initial.groups);

  const role = roles.find((r) => r.id === roleId) ?? null;
  const roleReach = React.useMemo(() => reachOf(role, tree), [role, tree]);
  const roleCaps = React.useMemo(() => effectiveCapabilities(role), [role]);
  const reachEditable = (role?.scope?.environmentIds.length ?? 0) === 0;

  function pickRole(id: string) {
    const next = roles.find((r) => r.id === id) ?? null;
    setRoleId(id);
    setSelection(reachOf(next, tree));
    setCaps(effectiveCapabilities(next));
  }

  const ticked = tickedIds(selection);
  const covers = coversRoleReach(selection, role, tree);
  const granular = reachEditable && !covers;
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

  const lockReason = access.isFounder
    ? "The team's primary owner. Their access can't be changed by anyone, and ownership moves by transferring the team."
    : isSelf
      ? "Your own membership. Another admin has to change it for you."
      : member.role === "owner" && !canAssignOwner
        ? "An owner's access can only be changed by another owner."
        : null;
  const readOnly = lockReason != null;
  const canRemove = !readOnly;
  const canTransfer = viewerIsPrimaryOwner && !isSelf && !member.isPrimaryOwner;
  const onNodes = boundedBy(caps, NODE_GRANTABLE_CAPABILITIES);
  const reachLimited = granular || role?.scope != null;
  const nothingTicked = ticked.length === 0 && tree.length > 0;
  const nothingAllowed =
    (reachLimited ? onNodes : caps).filter((c) => c !== "view").length === 0;
  const blocked = readOnly || !roleId || nothingTicked || nothingAllowed;
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
            grants: buildGrants(
              granular ? selection : extra,
              groups,
              onNodes,
              !sameCapabilities(caps, initial.capabilities),
            ),
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
            avatarUrl={member.avatarUrl}
            size="xl"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className={titleClass.page}>@{member.username}</h1>
              {member.roleName && (
                <Badge variant="outline">{member.roleName}</Badge>
              )}
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

        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <TabsContent value="permissions" className="space-y-4 pt-2">
            {lockReason && (
              <div className="flex items-center gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
                <Lock className="size-5 shrink-0 text-[var(--warning)]" />
                <p className="text-sm">{lockReason}</p>
              </div>
            )}
            {!access.isFounder && (
              <Card>
                <CardContent className="pt-6">
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
                      ? "Everywhere their role reaches is ticked. Untick what this one person shouldn't touch. Everything under a ticked node follows it."
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

        <TabsContent value="activity" className="pt-2">
          {activity}
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4 pt-2">
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
                  className="border-destructive/40 text-destructive hover:bg-destructive-wash-strong hover:text-destructive"
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
                  className="border-destructive/40 text-destructive hover:bg-destructive-wash-strong hover:text-destructive"
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
          description={
            <>
              <strong>@{member.username}</strong> gets the Owner role and full
              access to this team.
            </>
          }
          consequence="Nobody here can remove, demote or edit them. You stay an owner, but only they can hand the team back."
          confirmLabel="Transfer ownership"
          confirmText={member.username}
          successMessage="Team ownership transferred"
          extra={
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="transfer-password">Your password</Label>
                <RevealInput
                  id="transfer-password"
                  autoComplete="current-password"
                  value={transferPassword}
                  onChange={(e) => setTransferPassword(e.target.value)}
                />
              </div>
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
        description={
          <>
            <strong>@{member.username}</strong> loses access to this team&apos;s
            apps and resources right away. Their account is untouched.
          </>
        }
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

function effectiveCapabilities(role: TeamRoleDTO | null): Capability[] {
  if (!role) return ["view"];
  return role.scope
    ? boundedBy(role.capabilities, PROJECT_SCOPED_CAPABILITIES)
    : role.capabilities;
}

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

function union(a: ScopeSelection, b: ScopeSelection): ScopeSelection {
  const merge = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    teamIds: [],
    projectIds: merge(a.projectIds, b.projectIds),
    folderIds: merge(a.folderIds, b.folderIds),
    appIds: merge(a.appIds, b.appIds),
  };
}

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

export interface NodeGroup {
  capabilities: Capability[];
  nodeIds: string[];
}

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

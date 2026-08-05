"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Crown, Loader2, ShieldAlert, UserMinus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { PermissionPicker } from "@/components/settings/permission-picker";
import {
  ScopePicker,
  type ScopeNode,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { gqlAction } from "@/lib/graphql-client";
import { useGraphqlMutation } from "@/lib/use-graphql";
import { NODE_GRANTABLE_CAPABILITIES } from "@/lib/membership-shared";
import {
  accessSignature,
  emptyTickedNodes,
  groupGrants,
  type TickedNode,
} from "@/lib/user-access-grants";
import { cn } from "@/lib/utils";
import type { Capability } from "@/lib/types";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { TeamRoleOption, UserTeamAccessDTO } from "@/lib/data/user-access";

/**
 * Settings → Users → a person → what they can do in each team: the client half
 * of `lib/data/user-access.ts`, and the only place an admin can hand someone one
 * corner of the fleet without giving them the capability team-wide.
 *
 * One card per team, because that is the shape of the write: `setUserTeamAccess`
 * takes one team and replaces its whole access in a transaction. Each card saves
 * on its own and nothing is cross-team.
 *
 * The tree is the SAME control the API-token editor uses, with one difference
 * that follows from the model: a token's tick means "can reach", so a team can be
 * ticked; a grant's tick means "a different set applies inside here", which a
 * team cannot say (that is the role). Hence `teamPickable={false}`.
 */
export function UserAccessEditor({
  userId,
  username,
  access,
  tree,
  roleOptions,
}: {
  userId: string;
  username: string;
  /** Their membership in every team they are in, newest team last. */
  access: UserTeamAccessDTO[];
  /** The scope tree rooted at THEIR teams, one entry per team. */
  tree: ScopeTreeTeam[];
  /** Assignable roles, per team id. */
  roleOptions: Record<string, TeamRoleOption[]>;
}) {
  if (access.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm font-medium">Not in any team</p>
          <p className="mt-1 text-sm text-muted-foreground">
            @{username} has no access to anything yet. Add them to a team from
            that team&apos;s Members page.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {access.map((a) => (
        <TeamAccessCard
          key={a.teamId}
          userId={userId}
          access={a}
          tree={tree.filter((t) => t.id === a.teamId)}
          roles={roleOptions[a.teamId] ?? []}
        />
      ))}
    </div>
  );
}

const SET_ACCESS = /* GraphQL */ `
  mutation ($input: SetUserTeamAccessInput!) {
    setUserTeamAccess(input: $input) {
      teamId
      roleId
      granular
      nodes {
        kind
        nodeId
        capabilities
      }
    }
  }
`;

function TeamAccessCard({
  userId,
  access,
  tree,
  roles,
}: {
  userId: string;
  access: UserTeamAccessDTO;
  tree: ScopeTreeTeam[];
  roles: TeamRoleOption[];
}) {
  const router = useRouter();
  const initial = React.useMemo(() => fromDTO(access), [access]);
  const [roleId, setRoleId] = React.useState(initial.roleId);
  const [granular, setGranular] = React.useState(initial.granular);
  const [selection, setSelection] = React.useState<ScopeSelection>(
    initial.selection,
  );
  const [sets, setSets] = React.useState<Record<string, Capability[]>>(
    initial.sets,
  );
  const [baseline, setBaseline] = React.useState(() =>
    accessSignature({
      roleId: initial.roleId || null,
      granular: initial.granular,
      nodes: tickedNodes(initial.selection, initial.sets),
    }),
  );
  const { run, pending, error, setError } = useGraphqlMutation<{
    setUserTeamAccess: UserTeamAccessDTO[];
  }>(SET_ACCESS);
  // The hook keeps the failure; the house style is to surface the server's own
  // words, so it goes straight to a toast.
  React.useEffect(() => {
    if (!error) return;
    toast.error(error);
    setError(null);
  }, [error, setError]);

  // The founder's row is closed to everyone, instance admins included, so the
  // card renders as a statement rather than a form that would only ever toast.
  const locked = access.isFounder;
  const ticked = tickedNodes(selection, sets);
  const empty = granular ? emptyTickedNodes(ticked) : [];
  const signature = accessSignature({
    roleId: roleId || null,
    granular,
    nodes: ticked,
  });
  const dirty = signature !== baseline;
  const role = roles.find((r) => r.id === roleId) ?? null;

  /**
   * What a node starts with: what they can ALREADY do there through their role,
   * minus everything a grant can't carry. So ticking a node changes nothing on
   * its own, and the admin narrows or widens from a truthful starting point.
   */
  const defaultSet = React.useMemo(
    () =>
      NODE_GRANTABLE_CAPABILITIES.filter((c) =>
        access.baseCapabilities.includes(c),
      ),
    [access.baseCapabilities],
  );

  function changeScope(next: ScopeSelection) {
    setSelection(next);
    setSets((prev) => {
      const out: Record<string, Capability[]> = {};
      for (const id of [
        ...next.projectIds,
        ...next.folderIds,
        ...next.appIds,
      ]) {
        // Keep what a node already had; a newly ticked one starts from the role.
        out[id] = prev[id] ?? defaultSet;
      }
      return out;
    });
  }

  async function save() {
    const data = await run({
      input: {
        userId,
        teamId: access.teamId,
        roleId,
        granular,
        grants: granular ? groupGrants(ticked) : [],
      },
    });
    if (!data) return;
    const saved = data.setUserTeamAccess.find((a) => a.teamId === access.teamId);
    if (saved) {
      const next = fromDTO(saved);
      setRoleId(next.roleId);
      setGranular(next.granular);
      setSelection(next.selection);
      setSets(next.sets);
      setBaseline(
        accessSignature({
          roleId: next.roleId || null,
          granular: next.granular,
          nodes: tickedNodes(next.selection, next.sets),
        }),
      );
    }
    toast.success(`Access in ${access.teamName} saved`);
  }

  const blocked = empty.length > 0 || !roleId;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <span className="truncate">{access.teamName}</span>
          {access.rank === "owner" && (
            <Badge variant="secondary" className="gap-1 px-1.5 py-0">
              <Crown className="size-3" />
              Owner
            </Badge>
          )}
        </CardTitle>
        {!locked && (
          <Button size="sm" onClick={save} disabled={!dirty || pending || blocked}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {locked ? (
          <p className="text-sm text-muted-foreground">
            The team&apos;s primary owner. Their access can&apos;t be changed by
            anyone, instance admins included. Ownership moves by transferring the
            team.
          </p>
        ) : (
          <>
            <div className="max-w-sm space-y-1">
              <FieldLabel
                htmlFor={`role-${access.teamId}`}
                info="What they can do everywhere in this team. Editing the role itself, on the team's Roles page, reaches everyone who holds it."
              >
                Role
              </FieldLabel>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id={`role-${access.teamId}`} className="w-full">
                  <SelectValue placeholder="Custom set: pick a role to replace it" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!roleId && (
                <p className="mt-1 text-xs text-muted-foreground">
                  They hold a hand-picked set of permissions. Saving here puts
                  them on a role instead.
                </p>
              )}
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Per-node overrides</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Give them a different set of permissions inside single
                  projects, folders or apps. The role keeps applying everywhere
                  else.
                </p>
              </div>
              <Switch
                checked={granular}
                onCheckedChange={setGranular}
                aria-label="Per-node overrides"
              />
            </div>

            {/* A folder owner can hand out a grant from the Share dialog without
                this switch ever being on, and the save is a whole-set replace:
                turning it off deletes those too. Silent data loss unless the
                admin is told, so they are told. */}
            {!granular && access.nodes.length > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <ShieldAlert className="mt-px size-3.5 shrink-0" />
                <span>
                  They hold {access.nodes.length} override
                  {access.nodes.length === 1 ? "" : "s"} in this team
                  {access.nodes.length <= 3
                    ? ` (${access.nodes.map((n) => n.name).join(", ")})`
                    : ""}
                  , some possibly shared by a folder&apos;s owner. Saving with
                  this off removes every one of them.
                </span>
              </p>
            )}

            {granular && (
              <>
                <ScopePicker
                  tree={tree}
                  selection={selection}
                  onChange={changeScope}
                  teamPickable={false}
                  title="Overrides"
                  info="Tick a project, a folder or an app, then set what they may do inside it. Everything under a ticked node follows it."
                  emptyNote="This team has nothing to scope to yet: no projects, no folders and no apps."
                  footer={
                    <p className="text-xs text-muted-foreground">
                      {ticked.length === 0 ? (
                        <>
                          <span className="font-medium text-foreground">
                            No overrides yet.
                          </span>{" "}
                          The {role?.name ?? "current"} role applies everywhere
                          in this team.
                        </>
                      ) : (
                        <>
                          <span className="font-medium text-foreground">
                            {ticked.length} override
                            {ticked.length === 1 ? "" : "s"}.
                          </span>{" "}
                          Inside a ticked node this set replaces the role and can
                          grant more than the role does, so lowering the role
                          won&apos;t lower it here. To take it away, untick the
                          node or remove them from the team.
                        </>
                      )}
                    </p>
                  }
                  renderMeta={(node) => (
                    <NodeCapabilities
                      node={node}
                      ticked={isTicked(selection, node)}
                      capabilities={sets[node.id] ?? []}
                      onChange={(caps) =>
                        setSets((prev) => ({ ...prev, [node.id]: caps }))
                      }
                    />
                  )}
                />
                {empty.length > 0 && (
                  <p className="flex items-start gap-1.5 text-xs text-destructive">
                    <ShieldAlert className="mt-px size-3.5 shrink-0" />
                    <span>
                      {empty.length === 1 ? "One node grants" : `${empty.length} nodes grant`}{" "}
                      nothing. An override with no permissions would leave the
                      role applying there, which is the opposite of what a tick
                      says: pick at least one permission, or untick it.
                    </span>
                  </p>
                )}
              </>
            )}

            {/* The one action that takes EVERYTHING away at once, which is the
                answer the copy above points at: a node grant can outlive the
                role that no longer includes it, and only leaving the team clears
                the lot. It lives here because an instance admin sorting out
                someone's access may not be a member of the team at all, so the
                team's own Members page isn't theirs to reach. */}
            <div className="flex justify-end border-t border-border pt-3">
              <ConfirmAction
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <UserMinus className="size-4" />
                    Remove from {access.teamName}
                  </Button>
                }
                title={`Remove them from ${access.teamName}?`}
                description="They lose the role and every per-node override in this team at once. Apps, folders and data are untouched, and you can add them back from the team's Members page."
                confirmLabel="Remove"
                successMessage={`Removed from ${access.teamName}`}
                onConfirm={async () => {
                  const res = await gqlAction(
                    `mutation ($input: UserTeamInput!) {
                      removeUserFromTeam(input: $input) { teamId }
                    }`,
                    { input: { userId, teamId: access.teamId } },
                  );
                  // The card IS the membership: once it's gone the RSC read has
                  // to run again or the page keeps offering to edit nothing.
                  if (res.ok) router.refresh();
                  return res;
                }}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The per-row affordance: how many permissions this node grants, and the picker. */
function NodeCapabilities({
  node,
  ticked,
  capabilities,
  onChange,
}: {
  node: ScopeNode;
  /** Ticked HERE. A node covered by a ticked ancestor carries no set of its own. */
  ticked: boolean;
  capabilities: Capability[];
  onChange: (caps: Capability[]) => void;
}) {
  if (node.kind === "team" || !ticked) return null;
  const count = capabilities.filter((c) => c !== "view").length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("h-7 px-2 text-xs", count === 0 && "text-destructive")}
        >
          {count === 0
            ? "No permissions"
            : `${count} permission${count === 1 ? "" : "s"}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(32rem,70vh)] w-[min(30rem,90vw)] overflow-y-auto"
      >
        <p className="mb-3 text-sm">
          What they may do inside{" "}
          <span className="font-medium">{node.name}</span>
        </p>
        <PermissionPicker
          capabilities={capabilities}
          onChange={onChange}
          only={NODE_GRANTABLE_CAPABILITIES}
          hint="What this person may do inside this one node. Team-wide permissions such as Manage members or Manage roles can't be given here, so they aren't offered."
        />
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Split a saved DTO into the three pieces the form edits. */
function fromDTO(a: UserTeamAccessDTO): {
  roleId: string;
  granular: boolean;
  selection: ScopeSelection;
  sets: Record<string, Capability[]>;
} {
  const sets: Record<string, Capability[]> = {};
  for (const n of a.nodes) sets[n.nodeId] = n.capabilities;
  return {
    // "" is the Select's empty value: a membership with a hand-picked set has no
    // role to show, and the mutation requires one before it will save.
    roleId: a.roleId ?? "",
    granular: a.granular,
    selection: {
      teamIds: [],
      projectIds: a.nodes.filter((n) => n.kind === "project").map((n) => n.nodeId),
      folderIds: a.nodes.filter((n) => n.kind === "folder").map((n) => n.nodeId),
      appIds: a.nodes.filter((n) => n.kind === "app").map((n) => n.nodeId),
    },
    sets,
  };
}

function tickedNodes(
  selection: ScopeSelection,
  sets: Record<string, Capability[]>,
): TickedNode[] {
  const of = (kind: TickedNode["kind"], ids: string[]) =>
    ids.map((nodeId) => ({ kind, nodeId, capabilities: sets[nodeId] ?? [] }));
  return [
    ...of("project", selection.projectIds),
    ...of("folder", selection.folderIds),
    ...of("app", selection.appIds),
  ];
}

/** Ticked on its own row, as opposed to covered by a ticked ancestor. */
function isTicked(selection: ScopeSelection, node: ScopeNode): boolean {
  const ids =
    node.kind === "project"
      ? selection.projectIds
      : node.kind === "folder"
        ? selection.folderIds
        : node.kind === "app"
          ? selection.appIds
          : [];
  return ids.includes(node.id);
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  TeamAccessRow,
  draftFor,
  type TeamAccessDraft,
} from "@/components/settings/users/team-access-row";
import { gqlAction } from "@/lib/graphql-client";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { TeamRoleOption, UserTeamAccessDTO } from "@/lib/data/user-access";
import type { Capability } from "@/lib/types";

const SET_ACCESS = /* GraphQL */ `
  mutation ($input: SetUserTeamAccessInput!) {
    setUserTeamAccess(input: $input) {
      teamId
    }
  }
`;

const ADD_TO_TEAM = /* GraphQL */ `
  mutation ($input: UserTeamInput!) {
    addUserToTeam(input: $input) {
      teamId
    }
  }
`;

const REMOVE_FROM_TEAM = /* GraphQL */ `
  mutation ($input: UserTeamInput!) {
    removeUserFromTeam(input: $input) {
      teamId
    }
  }
`;

/**
 * Which teams this person is in, and what they can do inside each — the reason
 * this page exists. Until now the answer lived on each team's own Members page,
 * reachable only by someone already in that team, so "who can touch Prod?" had
 * no answer an instance admin could give.
 *
 * Each team saves on its own: they are independent writes on the server, and one
 * Save for five teams would make a mistake in one of them undo the other four.
 */
export function UserAccessSection({
  userId,
  access,
  roles,
  tree,
  joinable,
  disabled,
}: {
  userId: string;
  access: UserTeamAccessDTO[];
  roles: Record<string, TeamRoleOption[]>;
  tree: ScopeTreeTeam[];
  joinable: { id: string; name: string }[];
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [drafts, setDrafts] = React.useState<Record<string, TeamAccessDraft>>(
    () => Object.fromEntries(access.map((a) => [a.teamId, draftFor(a)])),
  );
  const [adding, setAdding] = React.useState<string>("");
  const [removing, setRemoving] = React.useState<UserTeamAccessDTO | null>(null);

  const treeByTeam = React.useMemo(
    () => new Map(tree.map((t) => [t.id, t])),
    [tree],
  );

  function save(a: UserTeamAccessDTO) {
    const draft = drafts[a.teamId];
    if (!draft?.roleId) return;
    startTransition(async () => {
      const res = await gqlAction(
        SET_ACCESS,
        { input: { ...grantsFor(draft), userId, teamId: a.teamId } },
        () => null,
      );
      if (res.ok) {
        toast.success(`Saved ${a.teamName}`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function add() {
    const teamId = adding;
    const roleId = roles[teamId]?.find((r) => r.rank === "member")?.id;
    if (!teamId || !roleId) return;
    startTransition(async () => {
      const res = await gqlAction(
        ADD_TO_TEAM,
        { input: { userId, teamId, roleId } },
        () => null,
      );
      if (res.ok) {
        setAdding("");
        toast.success("Added to the team");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-base">
          Access
          <InfoTip content="Which teams they are in, and what they can do inside each one." />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {access.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            They are not in any team.
          </p>
        ) : (
          access.map((a) => {
            const draft = drafts[a.teamId];
            if (!draft) return null;
            const dirty = !sameDraft(draft, draftFor(a));
            return (
              <div key={a.teamId} className="space-y-2">
                <TeamAccessRow
                  access={a}
                  roles={roles[a.teamId] ?? []}
                  tree={treeByTeam.get(a.teamId)}
                  draft={draft}
                  onChange={(next) =>
                    setDrafts((d) => ({ ...d, [a.teamId]: next }))
                  }
                  onRemove={() => setRemoving(a)}
                  disabled={disabled || pending}
                />
                {dirty && !a.isFounder && (
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        setDrafts((d) => ({ ...d, [a.teamId]: draftFor(a) }))
                      }
                    >
                      Discard
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={disabled || pending || !draft.roleId}
                      onClick={() => save(a)}
                    >
                      Save {a.teamName}
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}

        {joinable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Select value={adding} onValueChange={setAdding} disabled={disabled}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="Add to a team" />
              </SelectTrigger>
              <SelectContent>
                {joinable.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || pending || !adding}
              onClick={add}
            >
              <Plus className="size-4" />
              Add
            </Button>
            {/* They land on Member and are tuned from the row above, rather than
                asking for a role in a dropdown they can't see the meaning of. */}
            <p className="mt-1 w-full text-xs text-muted-foreground">
              They join as a Member. Change it above once they are in.
            </p>
          </div>
        )}
      </CardContent>

      {removing && (
        <ConfirmAction
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title={`Remove them from ${removing.teamName}?`}
          description="They lose everything in that team at once, including any access you gave them on single projects, folders or apps. Nothing is deleted, and you can add them back."
          confirmLabel="Remove from team"
          successMessage="Removed from the team"
          onConfirm={async () => {
            const res = await gqlAction(
              REMOVE_FROM_TEAM,
              { input: { userId, teamId: removing.teamId } },
              () => null,
            );
            if (res.ok) {
              setRemoving(null);
              router.refresh();
            }
            return res;
          }}
        />
      )}
    </Card>
  );
}

/**
 * Turn the draft into the mutation's shape. Nodes sharing a set become ONE grant
 * entry, which is both smaller on the wire and exactly how "same permissions
 * everywhere" reads on the server: one entry naming every node.
 */
function grantsFor(draft: TeamAccessDraft) {
  const base = {
    roleId: draft.roleId,
    granular: draft.granular,
  };
  if (!draft.granular) return { ...base, grants: [] };

  const byCaps = new Map<
    string,
    { projectIds: string[]; folderIds: string[]; appIds: string[]; capabilities: Capability[] }
  >();
  const push = (
    kind: "project" | "folder" | "app",
    id: string,
    caps: Capability[],
  ) => {
    const key = [...caps].sort().join(",");
    const entry =
      byCaps.get(key) ??
      { projectIds: [], folderIds: [], appIds: [], capabilities: caps };
    if (kind === "project") entry.projectIds.push(id);
    else if (kind === "folder") entry.folderIds.push(id);
    else entry.appIds.push(id);
    byCaps.set(key, entry);
  };
  const capsOf = (key: string) =>
    draft.uniform ? draft.shared : (draft.perNode[key as never] ?? draft.shared);
  for (const id of draft.selection.projectIds)
    push("project", id, capsOf(`project:${id}`));
  for (const id of draft.selection.folderIds)
    push("folder", id, capsOf(`folder:${id}`));
  for (const id of draft.selection.appIds) push("app", id, capsOf(`app:${id}`));
  return { ...base, grants: [...byCaps.values()] };
}

/** Order-blind draft comparison — what decides whether Save is offered. */
function sameDraft(a: TeamAccessDraft, b: TeamAccessDraft): boolean {
  return (
    JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
  );
}

function normalize(d: TeamAccessDraft) {
  return {
    roleId: d.roleId,
    granular: d.granular,
    grants: grantsFor(d)
      .grants.map((g) => ({
        projectIds: [...g.projectIds].sort(),
        folderIds: [...g.folderIds].sort(),
        appIds: [...g.appIds].sort(),
        capabilities: [...g.capabilities].sort(),
      }))
      .sort((x, y) => x.capabilities.join().localeCompare(y.capabilities.join())),
  };
}

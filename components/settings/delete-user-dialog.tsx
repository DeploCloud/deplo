"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, KeyRound, Loader2, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

/** Mirrors the `DeleteUserImpact` GraphQL type (lib/data/user-delete.ts). */
interface TeamImpact {
  teamId: string;
  name: string;
  appCount: number;
  databaseCount: number;
  otherMemberCount: number;
}
interface Impact {
  userId: string;
  username: string;
  name: string;
  blockedReason: string | null;
  soloTeams: TeamImpact[];
  foundedTeams: TeamImpact[];
  keptTeams: { teamId: string; name: string }[];
  createdAppCount: number;
  ownedFolderCount: number;
  ownedProjectCount: number;
  ownedAppCount: number;
  tokenCount: number;
  vacatedTeams: string[];
}

const IMPACT_QUERY = /* GraphQL */ `
  query ($userId: String!) {
    deleteUserImpact(userId: $userId) {
      userId
      username
      name
      blockedReason
      soloTeams { teamId name appCount databaseCount otherMemberCount }
      foundedTeams { teamId name appCount databaseCount otherMemberCount }
      keptTeams { teamId name }
      createdAppCount
      ownedFolderCount
      ownedProjectCount
      ownedAppCount
      tokenCount
      vacatedTeams
    }
  }
`;

/**
 * Permanently delete a user account — the one irreversible action in Settings →
 * Users, so it opens by ASKING THE SERVER what it would actually destroy and
 * shows that instead of a generic warning.
 *
 * Two tiers, deliberately different affordances:
 *  - Teams the user is the only member of are listed, not offered: they are
 *    deleted no matter what, because a memberless team is unreachable forever
 *    (every read resolves through a membership) and its apps would keep running
 *    with nothing able to show or stop them.
 *  - Everything else the account merely OWNS is a checkbox, default off, each
 *    labelled with the real count behind it. "This person left" and "everything
 *    they built must go" are different decisions and only the operator knows
 *    which one they are making.
 */
export function DeleteUserDialog({
  userId,
  username,
  open,
  onOpenChange,
  onDeleted,
}: {
  userId: string;
  username: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * Fired once the account is actually gone. For a caller that is itself a view
   * OF that account (the user editor's danger zone) this is how it closes
   * instead of sitting there pointed at a user who no longer exists.
   */
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [impact, setImpact] = React.useState<Impact | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [deleteCreatedApps, setDeleteCreatedApps] = React.useState(false);
  const [deleteOwnedWorkspaces, setDeleteOwnedWorkspaces] = React.useState(false);
  const [deleteFoundedTeams, setDeleteFoundedTeams] = React.useState(false);

  // Read on open. The caller mounts this dialog only while it is open (and
  // unmounts it on close), so the preview is never stale across two openings and
  // there is nothing to clear here first — memberships and apps move between one
  // look and the next, and a stale preview is exactly the surprise this dialog
  // exists to prevent.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    gqlAction<{ deleteUserImpact: Impact }, Impact>(
      IMPACT_QUERY,
      { userId },
      (d) => d.deleteUserImpact,
    ).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setImpact(res.data);
      else if (!res.ok) setFailed(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const handleOpenChange = (v: boolean) => {
    // Reset the opt-ins on close so a previous choice never carries into the
    // next account (the repo's reset-on-close dialog idiom).
    if (!v) {
      setDeleteCreatedApps(false);
      setDeleteOwnedWorkspaces(false);
      setDeleteFoundedTeams(false);
    }
    onOpenChange(v);
  };

  const blocked = impact?.blockedReason ?? null;
  const loading = !impact && !failed;
  const soloApps = sum(impact?.soloTeams ?? [], (t) => t.appCount);
  const soloDatabases = sum(impact?.soloTeams ?? [], (t) => t.databaseCount);

  return (
    <ConfirmAction
      open={open}
      onOpenChange={handleOpenChange}
      title={`Delete @${username}?`}
      description={
        blocked
          ? blocked
          : "This removes the account for good. It can't be undone, and the person can't be restored — a suspension is the reversible option."
      }
      confirmLabel="Delete account"
      // The typed username is the last gate: everything below is a checkbox, and
      // a stray click on a destructive default button must not be enough.
      confirmText={username}
      // Nothing to confirm until the preview lands (the operator would be
      // agreeing to an unknown), and nothing to confirm ever if the account is
      // off limits.
      confirmDisabled={loading || failed !== null || blocked !== null}
      extra={
        <div className="grid max-h-[45vh] gap-3 overflow-y-auto text-sm">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Checking what this would delete
            </div>
          )}
          {failed && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              {failed}
            </p>
          )}
          {impact && !blocked && (
            <>
              {/* Not optional, so not a checkbox — a statement of fact, with the
                  numbers that make it concrete. */}
              {impact.soloTeams.length > 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                  <p className="flex items-center gap-1.5 font-medium text-destructive">
                    <AlertTriangle className="size-4 shrink-0" />
                    {impact.soloTeams.length === 1
                      ? "1 team is deleted with this account"
                      : `${impact.soloTeams.length} teams are deleted with this account`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Nobody else is in{" "}
                    {impact.soloTeams.length === 1 ? "it" : "them"}, so{" "}
                    {impact.soloTeams.length === 1 ? "it" : "they"} would be
                    unreachable forever.{" "}
                    {soloApps + soloDatabases === 0 ? (
                      <>
                        {impact.soloTeams.length === 1 ? "It is" : "They are"}{" "}
                        empty, so only the team{" "}
                        {impact.soloTeams.length === 1 ? "itself goes" : "rows go"}
                        .
                      </>
                    ) : (
                      <>
                        Everything inside goes too —{" "}
                        <span className="font-medium text-foreground">
                          {contentsLabel(soloApps, soloDatabases)}
                        </span>
                        , including data volumes, domains and backup schedules.
                      </>
                    )}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {impact.soloTeams.map((t) => (
                      <li
                        key={t.teamId}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate font-medium">{t.name}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {contentsLabel(t.appCount, t.databaseCount) || "empty"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* The opt-ins. Each is hidden when there is nothing to act on —
                  an empty checkbox is a question the operator can't answer. */}
              {impact.createdAppCount > 0 && (
                <Option
                  checked={deleteCreatedApps}
                  onChange={setDeleteCreatedApps}
                  title={`Also delete the ${countLabel(
                    impact.createdAppCount,
                    "app",
                  )} they created`}
                  detail="In teams that stay. Containers, volumes, domains and deploy history go with them. Off ⇒ the apps keep running and simply lose their creator."
                />
              )}
              {impact.ownedFolderCount + impact.ownedProjectCount > 0 && (
                <Option
                  checked={deleteOwnedWorkspaces}
                  onChange={setDeleteOwnedWorkspaces}
                  title={`Also delete the ${ownedLabel(impact)} they own`}
                  detail={
                    impact.ownedAppCount > 0
                      ? `Takes the ${countLabel(
                          impact.ownedAppCount,
                          "app",
                        )} inside with them. Off ⇒ they are kept and become team-managed.`
                      : `${
                          impact.ownedFolderCount + impact.ownedProjectCount === 1
                            ? "It is empty"
                            : "They are empty"
                        }. Off ⇒ kept, and team-managed from now on.`
                  }
                />
              )}
              {impact.foundedTeams.length > 0 && (
                <Option
                  tone="destructive"
                  checked={deleteFoundedTeams}
                  onChange={setDeleteFoundedTeams}
                  title={`Also delete the ${countLabel(
                    impact.foundedTeams.length,
                    "team",
                  )} they founded`}
                  detail={`${countLabel(
                    sum(impact.foundedTeams, (t) => t.otherMemberCount),
                    "other person",
                    "other people",
                  )} would lose everything in there${
                    contentsLabel(
                      sum(impact.foundedTeams, (t) => t.appCount),
                      sum(impact.foundedTeams, (t) => t.databaseCount),
                    )
                      ? `: ${contentsLabel(
                          sum(impact.foundedTeams, (t) => t.appCount),
                          sum(impact.foundedTeams, (t) => t.databaseCount),
                        )}`
                      : ""
                  }. Off ⇒ the teams stay and are left without a founder.`}
                >
                  <ul className="mt-2 space-y-1">
                    {impact.foundedTeams.map((t) => (
                      <li
                        key={t.teamId}
                        className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                      >
                        <span className="truncate">{t.name}</span>
                        <span className="shrink-0">
                          {countLabel(t.otherMemberCount, "other member")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Option>
              )}

              {/* What happens regardless, so nothing lands as a surprise. */}
              <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
                <p className="mb-1.5 font-medium text-foreground">
                  Always removed with the account
                </p>
                <ul className="space-y-1">
                  <li className="flex items-start gap-1.5">
                    <Users className="mt-0.5 size-3 shrink-0" />
                    Their membership of{" "}
                    {countLabel(
                      impact.keptTeams.length +
                        impact.foundedTeams.length +
                        impact.soloTeams.length,
                      "team",
                    )}
                    , and every folder or Project access grant they were given.
                  </li>
                  {impact.tokenCount > 0 && (
                    <li className="flex items-start gap-1.5">
                      <KeyRound className="mt-0.5 size-3 shrink-0" />
                      {countLabel(impact.tokenCount, "API token")} they minted —
                      revoked immediately.
                    </li>
                  )}
                </ul>
                <p className="mt-2">
                  Their activity history stays: the log is append-only, so
                  entries keep the name they were written with and stop linking
                  to an account.
                </p>
                {impact.vacatedTeams.length > 0 && (
                  <p className="mt-2">
                    They are the last person who can manage members in{" "}
                    <span className="font-medium text-foreground">
                      {impact.vacatedTeams.join(", ")}
                    </span>
                    . The longest-standing remaining member takes that over, so
                    the team stays manageable.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      }
      onConfirm={async () => {
        const res = await gqlAction<
          {
            deleteUser: {
              username: string;
              teamsDeleted: number;
              appsDeleted: number;
              databasesDeleted: number;
            };
          },
          {
            username: string;
            teamsDeleted: number;
            appsDeleted: number;
            databasesDeleted: number;
          }
        >(
          /* GraphQL */ `
            mutation ($input: DeleteUserInput!) {
              deleteUser(input: $input) {
                username
                teamsDeleted
                appsDeleted
                databasesDeleted
              }
            }
          `,
          {
            input: {
              userId,
              deleteCreatedApps,
              deleteOwnedWorkspaces,
              deleteFoundedTeams,
            },
          },
          (d) => d.deleteUser,
        );
        if (res.ok && res.data) {
          // Report what actually went, not a generic "deleted" — the counts are
          // the operator's only receipt for an irreversible action.
          const removed = [
            [res.data.teamsDeleted, "team"] as const,
            [res.data.appsDeleted, "app"] as const,
            [res.data.databasesDeleted, "database"] as const,
          ]
            .filter(([n]) => n > 0)
            .map(([n, noun]) => countLabel(n, noun));
          toast.success(
            `Deleted @${res.data.username}` +
              (removed.length ? ` · removed ${removed.join(", ")}` : ""),
          );
          router.refresh();
          onDeleted?.();
        }
        return res;
      }}
    />
  );
}

function Option({
  checked,
  onChange,
  title,
  detail,
  tone = "default",
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  detail: string;
  /** "destructive" marks the option that costs OTHER people their work. */
  tone?: "default" | "destructive";
  children?: React.ReactNode;
}) {
  const danger = tone === "destructive" && checked;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors",
        danger ? "border-destructive/40 bg-destructive/5" : "border-border",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span
          className={cn("block font-medium", danger && "text-destructive")}
        >
          {title}
        </span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
        {children}
      </span>
    </label>
  );
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((n, r) => n + pick(r), 0);
}

/** "1 app" / "3 apps" — the count always leads, so nothing reads as "some". */
function countLabel(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/**
 * "2 apps and 1 database", dropping whichever side is zero and returning "" when
 * both are — "1 app and 0 databases" reads like a form, not like a warning.
 */
function contentsLabel(apps: number, databases: number): string {
  const parts: string[] = [];
  if (apps > 0) parts.push(countLabel(apps, "app"));
  if (databases > 0) parts.push(countLabel(databases, "database"));
  return parts.join(" and ");
}

/** "2 folders and 1 Project", skipping whichever side is zero. */
function ownedLabel(impact: Impact): string {
  const parts: string[] = [];
  if (impact.ownedFolderCount > 0)
    parts.push(countLabel(impact.ownedFolderCount, "folder"));
  if (impact.ownedProjectCount > 0)
    parts.push(countLabel(impact.ownedProjectCount, "Project"));
  return parts.join(" and ");
}

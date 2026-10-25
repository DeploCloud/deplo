"use client";

import * as React from "react";
import { CircleCheck, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";
import { gql } from "@/lib/graphql-client";
import type { FixKind, Level } from "@/lib/security-updates/fix-kind";
import {
  groupByPackage,
  type PackageGroup,
} from "@/lib/security-updates/group";
import { plural, timeAgo } from "@/lib/utils";
import { SecurityLevelBadge } from "./security-level";
import { fixLine, UNREADABLE } from "./fix-line";

interface Update {
  vulnId: string;
  level: Level;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  fixedVersion: string | null;
  fix: FixKind;
  actionable: boolean;
  service: string;
}

interface Answer {
  checkedAt: string | null;
  unreadable: string[];
  newerTag: string | null;
  updates: Update[];
}

const QUERY = /* GraphQL */ `
  query ($appId: ID, $databaseId: ID) {
    securityUpdates(appId: $appId, databaseId: $databaseId) {
      checkedAt
      unreadable
      newerTag
      updates {
        vulnId
        level
        ecosystem
        packageName
        installedVersion
        fixedVersion
        fix
        actionable
        service
      }
    }
  }
`;

export function SecurityUpdatesDialog({
  open,
  onOpenChange,
  appId,
  databaseId,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId?: string;
  databaseId?: string;
  name: string;
}) {
  const [answer, setAnswer] = React.useState<Answer | null | undefined>(
    undefined,
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    gql<{ securityUpdates: Answer | null }>(
      QUERY,
      { appId: appId ?? null, databaseId: databaseId ?? null },
      ctrl.signal,
    )
      .then((d) => setAnswer(d.securityUpdates))
      .catch((e) => {
        if (!ctrl.signal.aborted)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [open, appId, databaseId]);

  const groups = groupByPackage(answer?.updates ?? []);
  // The service is worth naming only when the app runs more than one.
  const manyServices = new Set(answer?.updates.map((u) => u.service)).size > 1;
  const toApply = groups.filter((g) => g.actionable);
  const noFix = groups.filter((g) => !g.actionable);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Security updates</DialogTitle>
          <DialogDescription>
            Known security flaws in what <strong>{name}</strong> runs.{" "}
            <DocsLink topic="security.updates" />
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : answer === undefined ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading
          </div>
        ) : answer === null ? (
          <p className="text-sm text-muted-foreground">
            Security checks are turned off on this Deplo.
          </p>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            {answer.unreadable.map((u) => (
              <p key={u} className="text-sm text-muted-foreground">
                {UNREADABLE[u] ?? UNREADABLE.failed}
              </p>
            ))}
            {toApply.length === 0 && noFix.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-[var(--success)]">
                <CircleCheck className="size-4" />
                {answer.checkedAt
                  ? `Up to date, checked ${timeAgo(answer.checkedAt)}`
                  : "Not checked yet"}
              </div>
            ) : (
              <>
                <UpdateList
                  title="To apply"
                  groups={toApply}
                  newerTag={answer.newerTag}
                  manyServices={manyServices}
                />
                <UpdateList
                  title="No fix yet"
                  groups={noFix}
                  newerTag={answer.newerTag}
                  manyServices={manyServices}
                />
                <p className="text-xs text-muted-foreground">
                  {answer.checkedAt
                    ? `Checked ${timeAgo(answer.checkedAt)}`
                    : "Some images are not checked yet"}
                </p>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UpdateList({
  title,
  groups,
  newerTag,
  manyServices,
}: {
  title: string;
  groups: PackageGroup<Update>[];
  newerTag: string | null;
  manyServices: boolean;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="divide-y divide-border rounded-md border border-border bg-card">
        {groups.map((g) => {
          const u = g.items[0];
          return (
            <li key={g.key} className="flex items-start gap-3 px-3 py-2.5">
              <SecurityLevelBadge level={g.level} />
              <div className="min-w-0 text-sm">
                <p className="truncate font-mono text-xs">
                  {u.packageName} {u.installedVersion}
                  {g.fixedVersion ? ` -> ${g.fixedVersion}` : ""}
                  {manyServices && u.service ? (
                    <span className="text-muted-foreground">
                      {" "}
                      in {u.service}
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {fixLine({
                    fix: g.fix,
                    packageName: u.packageName,
                    fixedVersion: g.fixedVersion,
                    newerTag,
                  })}
                  {g.items.length > 1
                    ? ` · ${plural(g.items.length, "advisory", "advisories")}`
                    : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
import { useRouter } from "@/lib/nav";
import { gql } from "@/lib/graphql-client";
import { groupUpdates } from "@/lib/security-updates/group";
import { timeAgo } from "@/lib/utils";
import { UNREADABLE } from "./fix-line";
import type { Answer } from "./types";
import { UpdateList } from "./update-list";

const QUERY = /* GraphQL */ `
  query ($appId: ID, $databaseId: ID) {
    securityUpdates(appId: $appId, databaseId: $databaseId) {
      checkedAt
      unreadable
      newerTag
      updates {
        vulnId
        cve
        level
        cvss
        ecosystem
        packageName
        installedVersion
        fixedVersion
        fix
        actionable
        ignored
        ignoredUntil
        ignoreReason
        ignoredBy
        service
        imageRef
        osvUrl
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
  canIgnore = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId?: string;
  databaseId?: string;
  name: string;
  canIgnore?: boolean;
}) {
  const router = useRouter();
  const [answer, setAnswer] = React.useState<Answer | null | undefined>(
    undefined,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);

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
  }, [open, appId, databaseId, version]);

  const changed = () => {
    setVersion((v) => v + 1);
    router.refresh();
  };
  const groups = groupUpdates(answer?.updates ?? []);
  const isIgnored = (g: (typeof groups)[number]) =>
    g.items.every((u) => u.ignored);
  const toApply = groups.filter((g) => g.actionable && !isIgnored(g));
  // Important ones: listed for whoever wants them, never counted.
  const lessUrgent = groups.filter((g) => !g.actionable && !isIgnored(g));
  const ignored = groups.filter(isIgnored);
  // The service is worth naming only when the app runs more than one.
  const manyServices = new Set(answer?.updates.map((u) => u.service)).size > 1;
  const list = {
    newerTag: answer?.newerTag ?? null,
    manyServices,
    subject: { appId, databaseId },
    canIgnore,
    onChanged: changed,
  };

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
            {groups.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-[var(--success)]">
                <CircleCheck className="size-4" />
                {answer.checkedAt
                  ? `Up to date, checked ${timeAgo(answer.checkedAt)}`
                  : "Not checked yet"}
              </div>
            ) : (
              <>
                <UpdateList title="To apply" groups={toApply} {...list} />
                <UpdateList title="Less urgent" groups={lessUrgent} {...list} />
                <UpdateList
                  title={`Ignored (${ignored.length})`}
                  groups={ignored}
                  {...list}
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

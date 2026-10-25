"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";
import type { PackageGroup } from "@/lib/security-updates/group";
import { plural } from "@/lib/utils";
import { fixLine } from "./fix-line";
import { IgnoreDialog } from "./ignore-dialog";
import { SecurityLevelBadge } from "./security-level";
import type { Subject, Update } from "./types";

export function UpdateList({
  title,
  groups,
  newerTag,
  manyServices,
  subject,
  canIgnore,
  onChanged,
}: {
  title: string;
  groups: PackageGroup<Update>[];
  newerTag: string | null;
  manyServices: boolean;
  subject: Subject;
  canIgnore: boolean;
  onChanged: () => void;
}) {
  const [ignoring, setIgnoring] = React.useState<PackageGroup<Update> | null>(
    null,
  );
  const [pending, startTransition] = React.useTransition();
  if (groups.length === 0) return null;

  function stopIgnoring(g: PackageGroup<Update>) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($appId: ID, $databaseId: ID, $vulnIds: [String!]!) {
           unignoreSecurityUpdate(appId: $appId, databaseId: $databaseId, vulnIds: $vulnIds)
         }`,
        {
          appId: subject.appId ?? null,
          databaseId: subject.databaseId ?? null,
          vulnIds: g.items.map((u) => u.vulnId),
        },
      );
      if (!res.ok) return void toast.error(res.error);
      onChanged();
    });
  }

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="divide-y divide-border rounded-md border border-border bg-card">
        {groups.map((g) => {
          const u = g.items[0];
          const ignored = g.items.every((i) => i.ignored);
          return (
            <li key={g.key} className="flex items-start gap-3 px-3 py-2.5">
              <SecurityLevelBadge level={g.level} />
              <div className="min-w-0 flex-1 text-sm">
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
                  {ignored
                    ? `Ignored until ${u.ignoredUntil?.slice(0, 10)} by ${u.ignoredBy}` +
                      (u.ignoreReason ? `: ${u.ignoreReason}` : "")
                    : fixLine({
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
              {canIgnore ? (
                ignored ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => stopIgnoring(g)}
                  >
                    Stop ignoring
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setIgnoring(g)}
                  >
                    Ignore
                  </Button>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      {ignoring ? (
        <IgnoreDialog
          open
          onOpenChange={(o) => !o && setIgnoring(null)}
          subject={subject}
          packageName={ignoring.items[0].packageName}
          vulnIds={ignoring.items
            .filter((i) => !i.ignored)
            .map((i) => i.vulnId)}
          onDone={onChanged}
        />
      ) : null}
    </section>
  );
}

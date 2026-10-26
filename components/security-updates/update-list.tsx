"use client";

import * as React from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Collapse } from "@/components/shared/collapse";
import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";
import type { UpdateGroup } from "@/lib/security-updates/group";
import { cn, plural } from "@/lib/utils";
import { AdvisoryList } from "./advisory-list";
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
  groups: UpdateGroup<Update>[];
  newerTag: string | null;
  manyServices: boolean;
  subject: Subject;
  canIgnore: boolean;
  onChanged: () => void;
}) {
  const [ignoring, setIgnoring] = React.useState<UpdateGroup<Update> | null>(
    null,
  );
  const [pending, startTransition] = React.useTransition();
  if (groups.length === 0) return null;

  function stopIgnoring(g: UpdateGroup<Update>) {
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
        {groups.map((g) => (
          <UpdateRow
            key={g.key}
            g={g}
            newerTag={newerTag}
            manyServices={manyServices}
            action={
              !canIgnore ? null : g.items.every((i) => i.ignored) ? (
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
            }
          />
        ))}
      </ul>
      {ignoring ? (
        <IgnoreDialog
          open
          onOpenChange={(o) => !o && setIgnoring(null)}
          subject={subject}
          packageName={
            ignoring.image
              ? ignoring.items[0].imageRef
              : ignoring.items[0].packageName
          }
          vulnIds={ignoring.items
            .filter((i) => !i.ignored)
            .map((i) => i.vulnId)}
          onDone={onChanged}
        />
      ) : null}
    </section>
  );
}

// One advisory opens straight on osv.dev; several, or an image's, open a list of their own.
function UpdateRow({
  g,
  newerTag,
  manyServices,
  action,
}: {
  g: UpdateGroup<Update>;
  newerTag: string | null;
  manyServices: boolean;
  action: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const u = g.items[0];
  const ignored = g.items.every((i) => i.ignored);
  const single = g.items.length === 1;
  const label = `${g.image ? u.imageRef : `${u.packageName} ${u.installedVersion}`}${g.fixedVersion ? ` -> ${g.fixedVersion}` : ""}`;
  const titleClass =
    "inline-flex max-w-full items-center gap-1 font-mono text-xs underline-offset-2 hover:underline";

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <SecurityLevelBadge level={g.level} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="flex min-w-0 items-center gap-1">
          {single ? (
            <a
              href={u.osvUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={titleClass}
            >
              <span className="truncate">{label}</span>
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className={cn(titleClass, "cursor-pointer")}
            >
              <span className="truncate">{label}</span>
              <ChevronDown
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            </button>
          )}
          {manyServices && u.service ? (
            <span className="shrink-0 text-xs text-muted-foreground">
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
                flaws: g.items.length,
              })}
          {!g.image && !single
            ? ` · ${plural(g.items.length, "advisory", "advisories")}`
            : ""}
        </p>
        {single ? null : (
          <Collapse open={open} className="pt-2.5">
            <AdvisoryList updates={g.items} byPackage={g.image} />
          </Collapse>
        )}
      </div>
      {action}
    </li>
  );
}

"use client";

import { Loader2, Server as ServerIcon, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  ServerUseBadge,
  type ServerUse,
} from "@/components/servers/server-role-badge";
import type { ActionResult } from "@/lib/result";
import type {
  MovePreviewServer,
  TargetMovePreview,
} from "@/lib/data/deplo-move/target";
import { PeerLink } from "./peer-link";

const COUNTS: [keyof TargetMovePreview["counts"], string, string][] = [
  ["teams", "team", "teams"],
  ["users", "person", "people"],
  ["apps", "app", "apps"],
  ["databases", "database", "databases"],
  ["servers", "server", "servers"],
];

const USE_OF: Record<MovePreviewServer["role"], ServerUse> = {
  workloads: "everything",
  storage: "storage",
  build: "build",
  import: "import",
};

export function MovePreview({
  preview,
  checking,
  onCheckAgain,
  onStart,
}: {
  preview: TargetMovePreview;
  checking: boolean;
  onCheckAgain: () => void;
  onStart: () => Promise<ActionResult<unknown>>;
}) {
  // Server problems show on their row; anything else blocking is listed on its own.
  const otherProblems = preview.problems.filter(
    (p) => !preview.servers.some((s) => s.problem === p),
  );

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div>
        <p className="text-sm font-medium">
          Deplo {preview.version} at <PeerLink url={preview.peerUrl} />
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {COUNTS.map(([key, one, many]) => (
            <div
              key={key}
              className="flex flex-col-reverse rounded-lg border border-border bg-surface px-3 py-2"
            >
              <dt className="text-xs text-muted-foreground">
                {preview.counts[key] === 1 ? one : many}
              </dt>
              <dd className="text-lg font-semibold tabular-nums">
                {preview.counts[key]}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {preview.servers.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {preview.servers.map((s) => (
            <li key={s.id} className="space-y-1 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">{s.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {s.address}
                </span>
                <ServerUseBadge use={USE_OF[s.role]} />
                {s.isPanelHost && (
                  <Badge
                    variant="info"
                    title="The old Deplo runs on this server. It is handed over last, and its apps keep running."
                  >
                    Old Deplo
                  </Badge>
                )}
              </div>
              {s.problem && (
                <p className="text-sm text-destructive">{s.problem}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {(otherProblems.length > 0 || preview.warnings.length > 0) && (
        <ul className="space-y-1 text-sm">
          {otherProblems.map((p) => (
            <li key={p} className="text-destructive">
              {p}
            </li>
          ))}
          {preview.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={onCheckAgain} disabled={checking}>
          {checking && <Loader2 className="size-4 animate-spin" />}
          Check again
        </Button>
        <ConfirmAction
          trigger={<Button disabled={!preview.canStart}>Start move</Button>}
          title="Start the move?"
          description={
            <>
              This Deplo copies everything from the old one, then{" "}
              <strong>takes its servers over</strong>.
            </>
          }
          consequence={`Everything on this Deplo is replaced by the old Deplo's data, and you sign in again with your account from ${preview.peerUrl}.`}
          confirmLabel="Start move"
          onConfirm={onStart}
        />
      </div>
    </div>
  );
}

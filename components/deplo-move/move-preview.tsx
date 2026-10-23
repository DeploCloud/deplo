"use client";

import {
  ArrowRight,
  Loader2,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  ServerUseBadge,
  type ServerUse,
} from "@/components/servers/server-role-badge";
import { databaseClashes } from "@/lib/deplo-move/database-clash";
import type { ActionResult } from "@/lib/result";
import type {
  MovePreviewServer,
  TargetMovePreview,
} from "@/lib/data/deplo-move/target";
import { PeerLink } from "./peer-link";
import type { ServerMap } from "./use-move-in";

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

function holds(s: MovePreviewServer): string {
  const parts = [
    s.apps > 0 && `${s.apps} ${s.apps === 1 ? "app" : "apps"}`,
    s.databases > 0 &&
      `${s.databases} ${s.databases === 1 ? "database" : "databases"}`,
  ].filter(Boolean);
  if (parts.length) return parts.join(", ");
  if (s.role === "storage") return "Backups";
  if (s.role === "build") return "Builds";
  return s.role === "workloads" ? "No apps" : "Nothing to copy";
}

export function MovePreview({
  preview,
  map,
  onTarget,
  checking,
  onCheckAgain,
  onStart,
  onBack,
}: {
  preview: TargetMovePreview;
  map: ServerMap;
  onTarget: (from: string, to: string) => void;
  checking: boolean;
  onCheckAgain: () => void;
  onStart: () => Promise<ActionResult<unknown>>;
  onBack?: () => void;
}) {
  // Server problems show on their row; a database clash follows the map as it is chosen now.
  const nameOf = (id: string) =>
    preview.targets.find((t) => t.id === id)?.name ?? "one server here";
  const clashesWith = (to: (from: string) => string | null | undefined) =>
    databaseClashes(preview.servers, to, nameOf);
  const asPreviewed = clashesWith(
    (from) => preview.servers.find((s) => s.id === from)?.target,
  );
  const clashes = clashesWith((from) => map[from]);
  const otherProblems = preview.problems.filter(
    (p) =>
      !preview.servers.some((s) => s.problem === p) && !asPreviewed.includes(p),
  );
  const blocked =
    preview.servers.some((s) => s.problem) ||
    otherProblems.length > 0 ||
    clashes.length > 0;
  const unmapped = preview.servers.some(
    (s) => s.choices.length > 0 && !map[s.id],
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
            <ServerRow
              key={s.id}
              server={s}
              targets={preview.targets}
              value={map[s.id] ?? ""}
              onChange={(to) => onTarget(s.id, to)}
            />
          ))}
        </ul>
      )}

      {(otherProblems.length > 0 ||
        clashes.length > 0 ||
        preview.warnings.length > 0) && (
        <ul className="space-y-1 text-sm">
          {[...otherProblems, ...clashes].map((p) => (
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
        {onBack && (
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        )}
        <Button
          variant="outline"
          onClick={onCheckAgain}
          disabled={checking}
          className={onBack ? "ml-auto" : undefined}
        >
          {checking && <Loader2 className="size-4 animate-spin" />}
          Check again
        </Button>
        <ConfirmAction
          trigger={<Button disabled={blocked || unmapped}>Start move</Button>}
          title="Start the move?"
          description={
            <>
              This Deplo copies everything from the old one, then{" "}
              <strong>deploys every app here</strong>.
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

function ServerRow({
  server: s,
  targets,
  value,
  onChange,
}: {
  server: MovePreviewServer;
  targets: TargetMovePreview["targets"];
  value: string;
  onChange: (to: string) => void;
}) {
  const offered = targets.filter((t) => s.choices.includes(t.id));
  return (
    <li className="space-y-2 px-3 py-2.5">
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
            title="The old Deplo runs on this server. It keeps running there."
          >
            Old Deplo
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-28 text-muted-foreground">{holds(s)}</span>
        <ArrowRight
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        {offered.length > 0 ? (
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger
              className="w-full sm:w-64"
              aria-label={`Server here for ${s.name}`}
            >
              <SelectValue placeholder="Choose a server" />
            </SelectTrigger>
            <SelectContent>
              {offered.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.isThisMachine ? `${t.name} (this machine)` : t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : s.role === "import" ? (
          <span className="text-muted-foreground">
            Stays with the old Deplo
          </span>
        ) : null}
      </div>
      {s.problem && <p className="text-sm text-destructive">{s.problem}</p>}
    </li>
  );
}

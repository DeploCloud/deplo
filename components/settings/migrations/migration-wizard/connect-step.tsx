"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Loader2, Server as ServerIcon, TriangleAlert, X } from "lucide-react";

import { SELF_PANEL_REFUSAL } from "@/lib/migration/self";
import { docsUrl } from "@/lib/docs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeBlock } from "@/components/shared/code-block";
import { Input } from "@/components/ui/input";
import { KindCard } from "@/components/shared/kind-card";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { FieldLabel } from "@/components/ui/info-tip";
import { TargetSelect } from "../target-select";
import { TeamImagePicker } from "../team-image-picker";
import {
  copyFor,
  SOURCE_COPY,
  SOURCE_KINDS,
  SourceMark,
  type SourceKind,
} from "../sources";
import { StepShell } from "../step-shell";
import type { QueuedTeam, TeamTarget } from "../queue";
import type { TargetTeam } from "../types";

// ScanErrorLog - what each probe answered, out of the warning and behind one link.
function ScanErrorLog({ log }: { log: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className="justify-self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        View logs
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What each panel answered</DialogTitle>
            <DialogDescription>
              Deplo asks both products in turn. Neither one recognised this
              address.
            </DialogDescription>
          </DialogHeader>
          <CodeBlock code={log} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ConnectStep - the panel address, the tokens, and the list of teams they read.
export function ConnectStep({
  url,
  setUrl,
  apiKey,
  setApiKey,
  sameMachineHost,
  takeover,
  scanning,
  kind,
  forcedKind,
  setForcedKind,
  scanError,
  queue,
  targetTeams,
  adding,
  onAdd,
  onRetarget,
  onSetImage,
  onRemove,
  onSubmit,
  onBack,
}: {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  sameMachineHost: string;
  takeover: boolean;
  scanning: boolean;
  kind: SourceKind | null;
  forcedKind: SourceKind | null;
  setForcedKind: (v: SourceKind | null) => void;
  scanError: string | null;
  queue: QueuedTeam[];
  targetTeams: TargetTeam[];
  adding: boolean;
  onAdd: () => void;
  onRetarget: (i: number, target: TeamTarget) => void;
  onSetImage: (i: number, image: string | null) => void;
  onRemove: (i: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  onBack?: () => void;
}) {
  const copy = copyFor(kind);
  const [scanHeadline, ...scanLines] = (scanError ?? "").split("\n");
  const scanLog = scanLines.join("\n\n");
  const busy = scanning || adding;
  const label = scanning
    ? copy.scanBusy
    : queue.length === 0
      ? copy.scanIdle
      : apiKey.trim()
        ? `Add this ${copy.teamLabel}`
        : `Continue with ${queue.length} ${copy.teamLabel}${queue.length === 1 ? "" : "s"}`;
  return (
    <StepShell
      hero
      title={copy.connectTitle}
      lead="Nothing is written on either side until you have seen what would come over."
      stagger={takeover}
    >
      <form
        className={cn("grid gap-4", takeover && "deplo-stagger")}
        onSubmit={onSubmit}
      >
        <div className="grid gap-2">
          <FieldLabel
            htmlFor="source-url"
            info={
              takeover ? (
                `Where ${copy.name} answers on this machine. There is no other panel to point at from here.`
              ) : (
                <>
                  {copy.urlInfo} On the same machine as Deplo, that is{" "}
                  <code>{`http://${sameMachineHost}:${copy.privatePort}`}</code>
                  .
                </>
              )
            }
            docs={copy.docs}
          >
            Panel address
          </FieldLabel>
          <Input
            id="source-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={copy.urlPlaceholder}
            autoComplete="off"
            spellCheck={false}
            readOnly={takeover}
            className={takeover ? "opacity-60" : undefined}
          />
        </div>

        <div className="grid gap-2">
          <FieldLabel
            htmlFor="source-token"
            info={copy.tokenInfo}
            docs={copy.docs}
          >
            {copy.tokenLabel}
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id="source-token"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste the key"
              autoComplete="off"
              spellCheck={false}
              className="flex-1"
            />
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              disabled={busy || !url.trim() || !apiKey.trim()}
              onClick={onAdd}
            >
              {adding && <Loader2 className="size-4 animate-spin" />}
              Add
            </Button>
          </div>
        </div>

        {queue.length > 0 && (
          <div>
            <p className="text-sm font-medium">Teams to bring over</p>
            <ul className="mt-1 divide-y divide-border rounded-lg border border-border bg-background">
              {queue.map((q, i) => (
                <li
                  key={`${q.sourceTeamId ?? ""}-${i}`}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                >
                  {q.target.kind === "new" && q.status === "waiting" ? (
                    <TeamImagePicker
                      name={q.name || copy.teamLabel}
                      image={q.image}
                      disabled={busy}
                      onChange={(image) => onSetImage(i, image)}
                    />
                  ) : (
                    <TeamAvatar
                      name={q.name || copy.teamLabel}
                      avatarUrl={null}
                      size="sm"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {q.name || `An unnamed ${copy.teamLabel}`}
                  </span>
                  {q.status === "done" && <Badge variant="success">Done</Badge>}
                  {q.status === "skipped" && (
                    <Badge variant="secondary">Skipped</Badge>
                  )}
                  {q.status === "stopped" && (
                    <Badge variant="secondary">Stopped</Badge>
                  )}
                  {q.status === "failed" && (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                  {q.status === "waiting" && (
                    <>
                      <span className="text-muted-foreground">lands in</span>
                      <TargetSelect
                        value={q.target}
                        teams={targetTeams}
                        sourceName={q.name || `an unnamed ${copy.teamLabel}`}
                        disabled={busy}
                        onChange={(target) => onRetarget(i, target)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${q.name || `this ${copy.teamLabel}`}`}
                        onClick={() => onRemove(i)}
                      >
                        <X className="size-4" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!takeover && (
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ServerIcon className="size-4 text-muted-foreground" />
                Take over your VPS
                <Badge variant="info">Beta</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Putting Deplo on the machine {copy.name} already runs on? The
                installer brings everything across and takes the ports for you.
              </p>
            </div>
            <Button variant="secondary" size="sm" className="shrink-0" asChild>
              <a
                href={docsUrl("migration.takeover")}
                target="_blank"
                rel="noreferrer"
              >
                Read the docs
              </a>
            </Button>
          </div>
        )}

        {scanError && (
          <div className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive-wash p-3 leading-relaxed">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="grid min-w-0 gap-1">
                <p className="text-sm text-muted-foreground">{scanHeadline}</p>
                {scanLog && <ScanErrorLog log={scanLog} />}
              </div>
            </div>
            <div
              hidden={
                takeover || queue.length > 0 || scanError === SELF_PANEL_REFUSAL
              }
            >
              <p className="text-sm font-medium">Which one is this?</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SOURCE_KINDS.map((k) => (
                  <KindCard
                    key={k}
                    selected={forcedKind === k}
                    onSelect={() => setForcedKind(k)}
                    icon={<SourceMark kind={k} />}
                    title={SOURCE_COPY[k].name}
                    caption={
                      k === "dokploy"
                        ? "Its key comes from Settings, Profile, API/CLI."
                        : "Its token comes from Keys & Tokens."
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div className={cn("flex", onBack ? "justify-between" : "justify-end")}>
          {onBack && (
            <Button type="button" variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
          <Button
            type="submit"
            disabled={
              busy || !url.trim() || (queue.length === 0 && !apiKey.trim())
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {label}
          </Button>
        </div>
      </form>
    </StepShell>
  );
}

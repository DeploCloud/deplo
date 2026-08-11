"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { ARTIFACT_MAGIC_BYTES, looksEncrypted } from "@/lib/backups/artifact-format";
import { uploadRestore } from "@/lib/backups/restore-upload-client";
import { formatBytes } from "@/lib/utils";
import type { ActionResult } from "@/lib/result";

/**
 * Restore an app or a database from an artifact the operator has on their own
 * machine.
 *
 * The one recovery path that does not need this instance to remember anything:
 * every other restore starts from a run Deplo recorded, so a lost control plane
 * or a deleted destination takes the artifacts out of reach with it. Here the
 * file IS the restore point.
 *
 * Whether a recovery key is needed is read off the file rather than asked: an
 * encrypted artifact says so in its first bytes, and the file Deplo's own
 * Download hands over is already decrypted and needs none.
 */
export function RestoreFromFile({
  target,
  canRestore,
}: {
  target: { kind: "app" | "database"; id: string; name: string };
  /** `restore_backups` - the same gate the row-level restore carries. */
  canRestore: boolean;
}) {
  const router = useRouter();
  const fileId = React.useId();
  const keyId = React.useId();
  const [file, setFile] = React.useState<File | null>(null);
  const [encrypted, setEncrypted] = React.useState(false);
  const [recoveryKey, setRecoveryKey] = React.useState("");
  const [percent, setPercent] = React.useState<number | null>(null);
  const [lines, setLines] = React.useState<string[]>([]);
  const noun = target.kind === "app" ? "app" : "database";

  const trigger = (
    <Button size="sm" variant="outline" disabled={!canRestore}>
      <Upload className="size-4" />
      Restore from file
    </Button>
  );

  if (!canRestore) {
    return (
      <SimpleTooltip content="You don't have permission to restore backups">
        {/* Disabled buttons swallow pointer events, so wrap in a focusable span
            to keep the tooltip reachable. */}
        <span tabIndex={0}>{trigger}</span>
      </SimpleTooltip>
    );
  }

  async function pick(picked: File | null) {
    setFile(picked);
    setLines([]);
    setPercent(null);
    if (!picked) {
      setEncrypted(false);
      return;
    }
    // age announces itself in the clear at the very start of the file, so this
    // costs 22 bytes and spares the operator a field they may not need.
    const head = new Uint8Array(
      await picked.slice(0, ARTIFACT_MAGIC_BYTES).arrayBuffer(),
    );
    setEncrypted(looksEncrypted(head));
  }

  function reset() {
    setFile(null);
    setEncrypted(false);
    setRecoveryKey("");
    setPercent(null);
    setLines([]);
  }

  async function run(): Promise<ActionResult> {
    if (!file) return { ok: false, error: "Pick a backup file to restore" };
    setLines([]);
    setPercent(0);
    try {
      await uploadRestore(
        { kind: target.kind, id: target.id },
        file,
        encrypted ? recoveryKey : "",
        (event) => {
          if (event.percent !== undefined) setPercent(event.percent);
          // Only the tail: this is a progress readout, not a log viewer, and the
          // agent's own log is where the whole run lives.
          if (event.line) setLines((current) => [...current, event.line!].slice(-8));
        },
      );
      router.refresh();
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Restore failed",
      };
    } finally {
      setPercent(null);
    }
  }

  return (
    <ConfirmAction
      trigger={trigger}
      onOpenChange={(open) => {
        if (!open) reset();
      }}
      title="Restore from a file"
      confirmLabel="Restore"
      successMessage="Restore finished"
      confirmText={target.name}
      confirmDisabled={!file || (encrypted && !recoveryKey.trim())}
      description={
        <span className="flex flex-col gap-2">
          <span className="flex items-start gap-2 text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              This overwrites <strong>{target.name}</strong> in place with the file
              you upload. The {noun} is stopped, its current data is wiped, and the
              current state is <strong>not recoverable</strong>.
            </span>
          </span>
          {target.kind === "app" && (
            <span>
              The volumes and files come from the file. The app keeps its current
              settings.
            </span>
          )}
        </span>
      }
      extra={
        <div className="grid gap-4">
          <div className="space-y-2">
            <FieldLabel
              htmlFor={fileId}
              info="The file a backup produced: the one Deplo downloads, or the .age artifact kept at the destination."
            >
              Backup file
            </FieldLabel>
            <Input
              id={fileId}
              type="file"
              accept=".gz,.tgz,.age"
              onChange={(e) => void pick(e.target.files?.[0] ?? null)}
            />
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {formatBytes(file.size)}
                {encrypted ? " · encrypted" : ""}
              </p>
            )}
          </div>

          {encrypted && (
            <div className="space-y-2">
              <FieldLabel
                htmlFor={keyId}
                info="The recovery key of the destination this file came from. Take it from Storage → Destinations, or from the key file you saved."
              >
                Recovery key
              </FieldLabel>
              <Input
                id={keyId}
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                placeholder="AGE-SECRET-KEY-1"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}

          {percent !== null && (
            <div className="space-y-2">
              <Progress value={percent} />
              <p className="text-xs text-muted-foreground">
                {percent < 100
                  ? `Uploading ${percent}%`
                  : `Restoring the ${noun} on its server`}
              </p>
              {lines.length > 0 && (
                <pre className="max-h-32 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
                  {lines.join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      }
      onConfirm={run}
    />
  );
}

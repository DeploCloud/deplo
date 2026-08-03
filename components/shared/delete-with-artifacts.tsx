"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gql, gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";

/**
 * Delete confirmation for an app or database that may have S3 backup artifacts.
 * Wraps {@link ConfirmAction} with:
 *  - an "also delete backup artifacts from S3" checkbox (default OFF — keeping
 *    artifacts is the safe default, per the locked decision), shown ONLY when the
 *    target actually has stored artifacts. When it has none there is nothing to
 *    sweep, so offering the option is just noise (and used to fire a doomed
 *    `deleteBackupArtifacts` on confirm).
 *  - the two-step delete it implies: when checked, sweep every bucket the target
 *    backed up to (`deleteBackupArtifacts`) BEFORE deleting the target itself, so
 *    the target row is still resolvable to its owning server for the S3 delete.
 *  - an optional {@link forceRetry} affordance for targets whose delete REFUSES
 *    when the server can't be cleaned (databases). It stays hidden until a normal
 *    delete has actually failed, so the healthy path never shows the knob.
 *
 * The artifact sweep is best-effort: if it fails, the target is still deleted (a
 * leftover bucket object is reapable later) — matching the keep-artifacts path.
 */
export function DeleteWithArtifacts({
  trigger,
  open,
  onOpenChange,
  targetKind,
  targetId,
  targetName,
  title,
  description,
  confirmLabel,
  successMessage,
  forceRetry,
  /** The mutation that deletes the target itself (db or project). */
  deleteMutation,
  onDeleted,
}: {
  /** Uncontrolled: render a trigger that opens the dialog. Omit when driving
   *  `open`/`onOpenChange` from a parent menu. */
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  targetKind: "database" | "app";
  targetId: string;
  targetName: string;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  successMessage?: string;
  /**
   * Opt-in escape hatch for a delete the server can REFUSE — a database whose
   * host is unreachable, so Deplo cannot prove its container and data volume are
   * gone. Omitted ⇒ no force path at all (apps proceed regardless, so they pass
   * nothing). Shown only after a delete attempt has failed: the operator sees the
   * real reason in the toast first, and only then the "do it anyway" choice.
   */
  forceRetry?: {
    /** Checkbox label — what the operator is opting into. */
    label: string;
    /** The consequence they are accepting, in one line. */
    description: string;
    /** Confirm-button label while the checkbox is on. */
    confirmLabel: string;
    /** Toast on a forced success — never the plain "deleted" (it isn't gone). */
    successMessage: string;
  };
  deleteMutation: (opts: { force: boolean }) => Promise<ActionResult<unknown>>;
  onDeleted: () => void;
}) {
  const [alsoDeleteArtifacts, setAlsoDeleteArtifacts] = React.useState(false);
  // A normal delete has come back refused, so the force choice is now relevant
  // (and only now). `force` is the operator's answer to it.
  const [refused, setRefused] = React.useState(false);
  const [force, setForce] = React.useState(false);
  // How many stored artifacts the target has: null while unknown (loading, or
  // the dialog is closed). The checkbox shows only once we KNOW there is at
  // least one — an error or a still-loading count keeps it hidden rather than
  // offering a sweep we can't stand behind.
  const [artifactCount, setArtifactCount] = React.useState<number | null>(null);

  // Own the open state even when the caller doesn't drive `open` (the danger-zone
  // trigger case): we need to know the moment the dialog opens to fetch the
  // artifact count, which an uncontrolled ConfirmAction would hide from us.
  const isControlled = open !== undefined;
  const [selfOpen, setSelfOpen] = React.useState(false);
  const actualOpen = isControlled ? open : selfOpen;

  // Reset on close so a previous choice never silently carries into the next
  // deletion (matches the repo's reset-on-close dialog idiom), and clear the
  // count back to unknown so a reopen re-fetches rather than flashing a stale one.
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setAlsoDeleteArtifacts(false);
      setArtifactCount(null);
      setRefused(false);
      setForce(false);
    }
    if (!isControlled) setSelfOpen(v);
    onOpenChange?.(v);
  };

  // Fetch the artifact count each time the dialog opens (fresh: a backup may
  // have run since it last opened).
  React.useEffect(() => {
    if (!actualOpen) return;
    let cancelled = false;
    gql<{ backupArtifactCount: number }>(
      `query ($targetKind: BackupTargetKind!, $targetId: String!) {
        backupArtifactCount(targetKind: $targetKind, targetId: $targetId)
      }`,
      { targetKind, targetId },
    )
      .then((d) => {
        if (!cancelled) setArtifactCount(d.backupArtifactCount);
      })
      .catch(() => {
        // Treat an errored count as "none to offer" — deleting the target still
        // works; the operator can sweep leftover artifacts from the backups view.
        if (!cancelled) setArtifactCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [actualOpen, targetKind, targetId]);

  const hasArtifacts = artifactCount != null && artifactCount > 0;

  return (
    <ConfirmAction
      trigger={trigger}
      open={actualOpen}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      confirmLabel={force && forceRetry ? forceRetry.confirmLabel : confirmLabel}
      successMessage={
        force && forceRetry ? forceRetry.successMessage : successMessage
      }
      confirmText={targetName}
      extra={
        hasArtifacts || (refused && forceRetry) ? (
          <div className="grid gap-2">
            {hasArtifacts && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
                <Checkbox
                  checked={alsoDeleteArtifacts}
                  onCheckedChange={(v) => setAlsoDeleteArtifacts(v === true)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">
                    Also delete backup artifacts from S3
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Permanently removes every stored backup of this {targetKind}{" "}
                    from your buckets. Off by default — backups are kept unless
                    you opt in.
                  </span>
                </span>
              </label>
            )}
            {refused && forceRetry && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <Checkbox
                  checked={force}
                  onCheckedChange={(v) => setForce(v === true)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{forceRetry.label}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {forceRetry.description}
                  </span>
                </span>
              </label>
            )}
          </div>
        ) : undefined
      }
      onConfirm={async () => {
        // When the operator opted to delete artifacts too, sweep them FIRST —
        // while the target row still resolves to its owning server (needed to
        // reach S3). The sweep itself is best-effort server-side (a single
        // bucket that 500s is skipped), but if the whole RPC fails (e.g. no
        // backup-capable agent is reachable) we ABORT here and surface the error
        // rather than delete the target: a half-done "delete with backups" that
        // silently leaves the buckets full is worse than a no-op the operator
        // can retry. Unchecked → straight to the target delete.
        if (alsoDeleteArtifacts) {
          const sweep = await gqlAction(
            `mutation($targetKind: BackupTargetKind!, $targetId: String!) {
              deleteBackupArtifacts(targetKind: $targetKind, targetId: $targetId)
            }`,
            { targetKind, targetId },
          );
          if (!sweep.ok) return sweep;
        }
        const res = await deleteMutation({ force });
        // A refusal is what unlocks the force choice — the operator reads WHY in
        // the error toast, then decides. (A forced attempt that still fails is
        // not a refusal to re-offer: the checkbox is already up.)
        if (!res.ok && !force) setRefused(true);
        if (res.ok) onDeleted();
        return res;
      }}
    />
  );
}

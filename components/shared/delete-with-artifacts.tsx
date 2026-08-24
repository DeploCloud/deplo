"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";

/**
 * Delete confirmation for an app or database, which takes its backups with it.
 *
 * IT ASKS ONE QUESTION. There used to be a second: a checkbox, off by default,
 * offering to keep the stored backups - and "keep" was a promise the platform
 * could not hold. Nothing listed those files afterwards, nothing could delete
 * them, and a sweep removed them a month later anyway, so the honest reading of
 * the checkbox was "keep them somewhere you cannot see, for a while". Deleting
 * the thing now deletes what belongs to it, which is what "delete" means and
 * what the typed confirmation is already for.
 *
 * The sweep runs BEFORE the target itself, so the rows still resolve to the
 * server that has to be dialed - and a sweep that fails ABORTS the delete rather
 * than orphaning files nothing can name again.
 *
 * {@link forceRetry} stays: it is the escape hatch for a delete the server can
 * REFUSE (a database whose host is unreachable, so Deplo cannot prove the
 * container and volume are gone). It appears only after a real failure.
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
  /** The mutation that deletes the target itself (db or app). */
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
   * Opt-in escape hatch for a delete the server can REFUSE - a database whose
   * host is unreachable, so Deplo cannot prove its container and data volume are
   * gone. Omitted ⇒ no force path at all (apps proceed regardless, so they pass
   * nothing). Shown only after a delete attempt has failed: the operator sees the
   * real reason in the toast first, and only then the "do it anyway" choice.
   */
  forceRetry?: {
    /** Checkbox label - what the operator is opting into. */
    label: string;
    /** The consequence they are accepting, in one line. */
    description: string;
    /** Confirm-button label while the checkbox is on. */
    confirmLabel: string;
    /** Toast on a forced success - never the plain "deleted" (it isn't gone). */
    successMessage: string;
  };
  deleteMutation: (opts: { force: boolean }) => Promise<ActionResult<unknown>>;
  onDeleted: () => void;
}) {
  // A normal delete has come back refused, so the force choice is now relevant
  // (and only now). `force` is the operator's answer to it.
  const [refused, setRefused] = React.useState(false);
  const [force, setForce] = React.useState(false);

  // Reset on close so a previous choice never silently carries into the next
  // deletion (matches the repo's reset-on-close dialog idiom).
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setRefused(false);
      setForce(false);
    }
    onOpenChange?.(v);
  };

  return (
    <ConfirmAction
      trigger={trigger}
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      confirmLabel={
        force && forceRetry ? forceRetry.confirmLabel : confirmLabel
      }
      successMessage={
        force && forceRetry ? forceRetry.successMessage : successMessage
      }
      confirmText={targetName}
      extra={
        refused && forceRetry ? (
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
        ) : undefined
      }
      onConfirm={async () => {
        // Sweep FIRST, while the target row still resolves to the server that has
        // to be dialed for it. A sweep that fails ABORTS: deleting the target over
        // files we could not clear would strand them where nothing can name them
        // again, and a no-op the operator can retry is the better failure.
        const sweep = await gqlAction(
          `mutation($targetKind: BackupTargetKind!, $targetId: String!) {
            deleteBackupArtifacts(targetKind: $targetKind, targetId: $targetId)
          }`,
          { targetKind, targetId },
        );
        if (!sweep.ok) return sweep;
        const res = await deleteMutation({ force });
        // A refusal is what unlocks the force choice - the operator reads WHY in
        // the error toast, then decides. (A forced attempt that still fails is
        // not a refusal to re-offer: the checkbox is already up.)
        if (!res.ok && !force) setRefused(true);
        if (res.ok) onDeleted();
        return res;
      }}
    />
  );
}

"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";

export function DeleteWithArtifacts({
  trigger,
  open,
  onOpenChange,
  targetKind,
  targetId,
  targetName,
  title,
  description,
  consequence,
  confirmLabel,
  successMessage,
  forceRetry,
  deleteMutation,
  onDeleted,
}: {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  targetKind: "database" | "app";
  targetId: string;
  targetName: string;
  title: string;
  description: React.ReactNode;
  consequence?: React.ReactNode;
  confirmLabel: string;
  successMessage?: string;
  forceRetry?: {
    label: string;
    description: string;
    confirmLabel: string;
    successMessage: string;
  };
  deleteMutation: (opts: { force: boolean }) => Promise<ActionResult<unknown>>;
  onDeleted: () => void;
}) {
  const [refused, setRefused] = React.useState(false);
  const [force, setForce] = React.useState(false);

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
      consequence={consequence}
      confirmLabel={
        force && forceRetry ? forceRetry.confirmLabel : confirmLabel
      }
      successMessage={
        force && forceRetry ? forceRetry.successMessage : successMessage
      }
      confirmText={targetName}
      extra={
        refused && forceRetry ? (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive-wash p-3 text-sm">
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
        const sweep = await gqlAction(
          `mutation($targetKind: BackupTargetKind!, $targetId: String!) {
            deleteBackupArtifacts(targetKind: $targetKind, targetId: $targetId)
          }`,
          { targetKind, targetId },
        );
        if (!sweep.ok) return sweep;
        const res = await deleteMutation({ force });
        if (!res.ok && !force) setRefused(true);
        if (res.ok) onDeleted();
        return res;
      }}
    />
  );
}

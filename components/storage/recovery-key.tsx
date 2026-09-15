"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { gql } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

function keyFileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "destination"
  );
}

export async function downloadRecoveryKey(id: string): Promise<boolean> {
  try {
    const data = await gql<{
      destinationRecoveryKey: {
        name: string;
        recipient: string;
        identity: string;
        where: string;
      };
    }>(
      `mutation ($id: String!) {
        destinationRecoveryKey(id: $id) { name recipient identity where }
      }`,
      { id },
    );
    const key = data.destinationRecoveryKey;
    const body =
      `# Deplo backups - recovery key for the destination "${key.name}"\n` +
      `# Keep this somewhere outside Deplo. Without it, the backups at this\n` +
      `# destination cannot be read if this instance is lost.\n` +
      `#\n` +
      `#   age -d -i deplo-recovery-key.txt backup.tar.gz.age > backup.tar.gz\n` +
      `#\n` +
      `# The backups are kept at: ${key.where}\n` +
      `# Each one is named deplo/<team>/<app|database>/<id>/<when>-<run>.<ext>.age\n` +
      `# An app backup unpacks to volumes/, files/ and snapshot/ (compose.yml, env).\n` +
      `#\n` +
      `# public key: ${key.recipient}\n` +
      `${key.identity}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `deplo-backups-recovery-key-${keyFileSlug(key.name)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Recovery key downloaded", {
      description: "Keep it somewhere outside Deplo",
    });
    return true;
  } catch (e) {
    toast.error(
      e instanceof Error ? e.message : "The recovery key could not be read",
    );
    return false;
  }
}

export function RecoveryKeyNudge({
  destinationId,
  title = "Save your recovery key",
  description = "These backups are encrypted. Without this key they cannot be read if you lose this instance.",
  onSaved,
  className,
}: {
  destinationId: string;
  title?: string;
  description?: string;
  onSaved?: () => void;
  className?: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const [saved, setSaved] = React.useState(false);
  if (saved) return null;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          if (!(await downloadRecoveryKey(destinationId))) return;
          setSaved(true);
          onSaved?.();
        })
      }
      className={cn(
        "flex w-full items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-left transition-colors hover:bg-[var(--warning)]/10",
        className,
      )}
    >
      <KeyRound className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-xs font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

export function offerRecoveryKey(id: string, name: string): void {
  toast.warning(`Save the recovery key for ${name}`, {
    description:
      "Backups here are encrypted. This key is the only way to read them if you lose this instance.",
    duration: Infinity,
    action: {
      label: "Download",
      onClick: () => void downloadRecoveryKey(id),
    },
  });
}

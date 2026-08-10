"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { gql } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

/**
 * Handing over a destination's recovery key, from every screen that has a reason
 * to.
 *
 * It used to live inside the Storage page's destination card, which is the one
 * screen someone can go their whole life without opening: the default
 * destination is seeded lazily from an app's Backups tab and from a database's,
 * the create dialog closes optimistically without ever mentioning a key, and
 * both leave encrypted artifacts behind. A key nobody was ever asked to take is
 * a key nobody has, and that is exactly the state the encryption exists to
 * prevent.
 */

/** The destination's name, flattened into something safe for a filename. */
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

/**
 * Fetch the key and save it as a file. Resolves true when the browser got it,
 * so a caller can refresh and drop its nudge.
 *
 * Downloading rather than showing: this key is meant to leave Deplo and be kept
 * somewhere else, and a string on screen invites a screenshot instead. Call it
 * from a real click - a download the user did not ask for is one the browser is
 * entitled to block.
 */
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
    // The age key-file format: comments, then the secret key on its own line.
    // `age -d -i this-file backup.tar.gz.age` reads it as-is.
    //
    // The WHERE and the naming line are not decoration. This file is opened in
    // exactly one situation - this instance is gone - and until they were here
    // it handed someone a key with no address: which bucket, which host, which
    // folder, and which of forty files belongs to which app all lived in the
    // database that was lost.
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
    // Named for what it is AND which destination it opens. This file ends up in
    // a password manager or a drawer, years before anyone needs it, next to
    // whatever else was downloaded that day - "deplo-recovery-key.txt" told its
    // finder neither product nor purpose, and an instance with two destinations
    // produced two files with the same name.
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

/**
 * The nudge: these backups are encrypted and nobody has taken the key yet.
 *
 * Shown on the destination card and on the Backups panel of anything that
 * writes to such a destination. It is a button, not a banner, because the fix
 * is one click and the click has to be the user's own.
 */
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
  // Local, and NOT just `onSaved` + a re-read: `router.refresh()` does not
  // repaint the app's Backups tab (nothing on it does - a backup_run inserted
  // while the page is open stays invisible too), so a warning that only clears
  // on fresh data would sit there after the user had already done the one thing
  // it asks for. The key is saved: say so immediately, and let the refresh
  // catch up on its own time.
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
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

/**
 * Offer the key right after a destination is created.
 *
 * A toast with an action rather than an automatic download: the create dialog
 * closes optimistically and the mutation lands seconds later, so there is no
 * click left to hang a download on - and a file that arrives unasked is one a
 * browser may quietly refuse. It never expires, and the card's own nudge stays
 * as the fallback for a toast nobody saw.
 */
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

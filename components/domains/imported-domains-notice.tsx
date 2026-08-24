"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Import, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { gqlAction } from "@/lib/graphql-client";
import { useAppCan } from "@/components/apps/app-capabilities";

/**
 * The one thing a migrated app does NOT keep: its address.
 *
 * A domain whose name could not come across is re-hosted rather than dropped -
 * the source's own throwaway host carries ITS server's IP, and a real name may
 * already be another team's here - so the app answers on an address Deplo
 * minted, with the same port, service and path. Nothing else about the app
 * changes, which is exactly why this is easy to miss: the app is up, the routes
 * are right, and the URL someone had bookmarked is gone.
 *
 * So it is stated where a person goes looking for an address, it stays until it
 * is dismissed (a toast would be gone before the page is read), and it is
 * dismissed PER APP - a migration brings over many, and one blanket dismissal
 * would hide the fact on every app that had not been looked at yet.
 *
 * Dismissing clears `importedFrom` on this app's domains: the provenance exists
 * for this message, and the import report keeps the permanent record of what
 * became what.
 */
export function ImportedDomainsNotice({
  appId,
  domains,
}: {
  appId: string;
  /** This app's domains that answer on a different name than they used to. */
  domains: { id: string; name: string; importedFrom: string }[];
}) {
  const router = useRouter();
  const canManage = useAppCan("manage_domains");
  const [pending, startTransition] = React.useTransition();
  if (domains.length === 0) return null;

  function dismiss() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($appId: String!) { dismissImportedDomains(appId: $appId) }`,
        { appId },
      );
      if (res.ok) router.refresh();
      else toast.error(res.error);
    });
  }

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm">
      <Import className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-medium text-warning">
          This app answers on a new address
        </p>
        <p className="text-muted-foreground">
          The
          {domains.length === 1 ? " address " : " addresses "}
          this app used before could not come across, so deplo gave it
          {domains.length === 1 ? " one " : " ones "}
          of its own with the same routes.
        </p>
        <ul className="space-y-1">
          {domains.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-1.5">
              {/* Dimmer, not struck through: the old address is not a mistake
                  someone made, it is where this app used to be reachable - and
                  it is the half a person is scanning for to recognise the row. */}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-muted-foreground/70">
                {d.importedFrom}
              </code>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                {d.name}
              </code>
              {/* On the NEW address only: it is the one somebody needs in their
                  hands right now - to open it, or to paste it into whatever was
                  pointing at the old one. */}
              <CopyButton value={d.name} className="size-6" />
            </li>
          ))}
        </ul>
      </div>
      {canManage && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-mt-0.5 -mr-1.5 shrink-0"
          onClick={dismiss}
          disabled={pending}
          aria-label="Dismiss"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ArrowRight, Import, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { gqlAction } from "@/lib/graphql-client";
import { useAppCan } from "@/components/apps/app-capabilities";

export function ImportedDomainsNotice({
  appId,
  domains,
}: {
  appId: string;
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
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-wash-strong px-3.5 py-2.5 text-sm">
      <Import className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-medium text-warning">
          This app answers on a new address
        </p>
        <p className="text-muted-foreground">
          The
          {domains.length === 1 ? " address " : " addresses "}
          this app used before could not come across, so Deplo gave it
          {domains.length === 1 ? " one " : " ones "}
          of its own with the same routes.
        </p>
        <ul className="space-y-1">
          {domains.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-1.5">
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-muted-foreground/70">
                {d.importedFrom}
              </code>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                {d.name}
              </code>
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

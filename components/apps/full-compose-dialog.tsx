"use client";

import * as React from "react";
import { FileText, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Shows the full Deplo-generated compose stack — the augmented YAML that
 * `docker compose` actually runs (Traefik + deplo labels, the injected `deplo`
 * network, absolute mount paths), as opposed to the clean source the user
 * authors in the editor. Rendered live on the server when the dialog opens.
 */
export function FullComposeDialog({ appId }: { appId: string }) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [yaml, setYaml] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Re-fetch each open: the rendered stack depends on the saved compose and the
  // current domain set, both of which can change between opens.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setLoading(true);
    setError(null);
    gqlAction(
      `mutation($appId: String!) { renderComposeStack(appId: $appId) }`,
      { appId },
      (d: { renderComposeStack: string | null }) => d.renderComposeStack,
    )
      .then((res) => {
        if (res.ok) setYaml(res.data ?? null);
        else setError(res.error);
      })
      .catch(() => setError("Could not render the compose stack"))
      .finally(() => setLoading(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <FileText className="size-4" />
          View full compose
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Full compose</DialogTitle>
          <DialogDescription>
            The stack Deplo generates and runs — your compose augmented with
            Traefik routing labels, the <code className="font-mono">deplo</code>{" "}
            network and absolute mount paths. Read-only; regenerated on every
            deploy.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Rendering…
          </div>
        ) : error ? (
          <p className="py-8 text-center text-sm text-destructive">{error}</p>
        ) : yaml ? (
          <div className="relative">
            <CopyButton value={yaml} className="absolute right-2 top-2 z-10" />
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed">
              <code className="font-mono">{yaml}</code>
            </pre>
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing to show yet — deploy this app once to generate its stack.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

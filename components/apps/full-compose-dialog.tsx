"use client";

import * as React from "react";
import dynamic from "next/dynamic";
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
import { DocsLink } from "@/components/ui/docs-link";

/**
 * CodeMirror is ~40KB and this dialog is rarely opened, so it stays out of the
 * Deployment page's bundle. Same reasoning as `storage-file-editor.tsx`.
 */
const TextEditor = dynamic(
  () => import("./text-editor").then((m) => m.TextEditor),
  {
    ssr: false,
    loading: () => (
      <div className="h-64 animate-pulse rounded-lg border border-input bg-muted/40" />
    ),
  },
);

/**
 * Shows the full Deplo-generated compose stack - the augmented YAML that `docker
 * compose` actually runs (Traefik + Deplo labels, the injected `deplo` network,
 * absolute mount paths), as opposed to the clean source the user authors in the
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
            The stack Deplo generates and runs, with routing, network and mount
            paths folded in. <strong>Read-only</strong>, regenerated on every
            deploy. <DocsLink topic="compose.differences" />
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
            <CopyButton value={yaml} className="absolute top-2 right-2 z-10" />
            <TextEditor
              value={yaml}
              onChange={() => {}}
              readOnly
              language="yaml"
              minHeight={200}
            />
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing to show yet - deploy this app once to generate its stack.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

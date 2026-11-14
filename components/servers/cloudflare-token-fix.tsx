"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import {
  CLOUDFLARE_TOKENS_PAGE,
  cloudflareTokenUrl,
} from "@/lib/cloudflare/token-url";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";

/** A dated name, so the new token stands apart from the old one in Cloudflare's list. */
export function newPanelTokenName(now: Date): string {
  return `Deplo panel ${now.toISOString().slice(0, 10)}`;
}

/** Cloudflare refuses the panel's token: open its form already filled in, then paste what it gives back. */
export function CloudflareTokenFixButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [name, setName] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function openDialog() {
    setToken("");
    setSaved(false);
    setName(newPanelTokenName(new Date()));
    setOpen(true);
  }

  function save() {
    startTransition(async () => {
      const res = await gqlAction<{
        replacePanelTunnelToken: { enabled: boolean };
      }>(
        /* GraphQL */ `
          mutation ReplacePanelTunnelToken($apiToken: String!) {
            replacePanelTunnelToken(apiToken: $apiToken) {
              enabled
            }
          }
        `,
        { apiToken: token.trim() },
      );
      if (!res.ok) return void toast.error(res.error);
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog}>
        Fix in Cloudflare
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          {saved ? (
            <>
              <DialogHeader>
                <DialogTitle>Deplo is using the new token</DialogTitle>
                <DialogDescription>
                  Delete the old one in Cloudflare: it is the{" "}
                  <strong>Deplo panel</strong> token that is not {name}.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button asChild>
                  <a
                    href={CLOUDFLARE_TOKENS_PAGE}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Cloudflare tokens
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (token.trim()) save();
              }}
            >
              <DialogHeader>
                <DialogTitle>Give Deplo a new Cloudflare token</DialogTitle>
                <DialogDescription>
                  Cloudflare opens with the right permissions filled in:{" "}
                  <strong>create the token</strong>, then paste it here.{" "}
                  <DocsLink topic="clusters.cloudflareToken" />
                </DialogDescription>
              </DialogHeader>
              <Button asChild variant="outline" className="justify-self-start">
                <a
                  href={cloudflareTokenUrl(name)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Create the token in Cloudflare
                  <ExternalLink className="size-4" />
                </a>
              </Button>
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="cloudflare-token-fix"
                  info="Deplo checks Cloudflare accepts it before it replaces the saved one, and keeps it encrypted."
                >
                  New token
                </FieldLabel>
                <Input
                  id="cloudflare-token-fix"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!token.trim() || pending}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

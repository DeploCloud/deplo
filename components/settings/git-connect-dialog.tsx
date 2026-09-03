"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/info-tip";
import { GitProviderMark } from "@/components/shared/brand-icons";
import { gqlAction } from "@/lib/graphql-client";
import type { GitProviderChoice } from "@/lib/types";

/**
 * The provider is already chosen, it was picked in the Connect menu, so this
 * dialog only asks for what Deplo cannot know: the address and the token.
 */
export function ConnectGitProviderDialog({
  provider,
  isInstanceAdmin,
  next,
  onClose,
  onConnected,
}: {
  provider: GitProviderChoice;
  isInstanceAdmin: boolean;
  next?: string | null;
  onClose: () => void;
  /** Told which connection was just made, for a caller that can select it. */
  onConnected?: (id: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [label, setLabel] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState(provider.defaultBaseUrl ?? "");
  const [username, setUsername] = React.useState(provider.defaultUsername);
  const [token, setToken] = React.useState("");
  const [allowPrivate, setAllowPrivate] = React.useState(false);

  const canSubmit = Boolean(baseUrl.trim() && token.trim() && !pending);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    startTransition(async () => {
      const res = await gqlAction<
        { connectGitProvider: { id: string } },
        { id: string }
      >(
        `mutation ($input: ConnectGitProviderInput!) {
          connectGitProvider(input: $input) { id label }
        }`,
        {
          input: {
            provider: provider.id,
            label: label.trim() || provider.label,
            baseUrl: baseUrl.trim(),
            username: username.trim(),
            token: token.trim(),
            allowPrivateEndpoint: allowPrivate,
          },
        },
        (d) => d.connectGitProvider,
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Provider connected");
      onClose();
      if (res.data) onConnected?.(res.data.id);
      // Straight back to whatever sent the user here (the create-app wizard's source
      // picker, an app's source settings), where the new connection is now in the list.
      if (next) router.push(next);
      else router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <GitProviderMark provider={provider.id} className="size-7" />
            Connect {provider.label}
          </DialogTitle>
          <DialogDescription>
            Paste a token once. Every app in this team can deploy from it.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="space-y-2">
              <FieldLabel
                htmlFor="git-base-url"
                info="The address you open in a browser, not the API address. A bare domain becomes https://."
                docs="git.connectionType"
              >
                Address
              </FieldLabel>
              <Input
                id="git-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://git.example.com"
                autoFocus
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="git-username"
                  info="The account the token belongs to. Leave the suggested value unless your provider says otherwise."
                  docs="git.connectionType"
                >
                  Username
                </FieldLabel>
                <Input
                  id="git-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={provider.defaultUsername || "your-username"}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="git-label">Name</FieldLabel>
                <Input
                  id="git-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={provider.label}
                />
              </div>
            </div>

            <div className="space-y-2">
              <FieldLabel htmlFor="git-token">Access token</FieldLabel>
              <Input
                id="git-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="glpat-"
                autoComplete="off"
              />
              {provider.tokenScopes && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Needs {provider.tokenScopes}.{" "}
                  {provider.tokenHelpUrl && (
                    <a
                      href={provider.tokenHelpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Create one
                    </a>
                  )}
                </p>
              )}
            </div>

            {/**
             * Self-hosted GitLab/Gitea is often on the same private network as the fleet, and
             * the SSRF guard on the address refuses that outright - so the ordinary form would
             * reject a perfectly normal setup.
             */}
            {isInstanceAdmin && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
                <Checkbox
                  checked={allowPrivate}
                  onCheckedChange={(v) => setAllowPrivate(v === true)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">
                    This git server is on my own network
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Allows a private address like 10.0.0.5 or a hostname that
                    resolves to one. Off by default so a mistyped address cannot
                    reach inside your network.
                  </span>
                </span>
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

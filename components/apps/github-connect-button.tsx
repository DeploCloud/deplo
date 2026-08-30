"use client";

import * as React from "react";
import { toast } from "sonner";
import { Building2, Loader2, User } from "lucide-react";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { GitHubIcon, GitProviderMark } from "@/components/shared/brand-icons";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Kicks off GitHub's App Manifest flow: asks the server for a manifest + signed
 * state, then POSTs them to GitHub via a transient form so the browser navigates
 * to GitHub to create (and then install) the App - no manual id/key copy/paste,
 */
export function useGithubConnect() {
  const [pending, startTransition] = React.useTransition();

  const connect = React.useCallback(
    (org?: string) => {
      // Call sites pass this straight to onClick/onSelect, so the first argument
      // is often an Event: anything that is not an org name means "my account".
      const owner = typeof org === "string" && org.trim() ? org.trim() : null;
      startTransition(async () => {
        const res = await gqlAction<
          {
            startGithubConnect: {
              actionUrl: string;
              manifest: string;
              state: string;
            } | null;
          },
          { actionUrl: string; manifest: string; state: string } | null
        >(
          `mutation ($org: String, $returnTo: String) { startGithubConnect(org: $org, returnTo: $returnTo) { actionUrl manifest state } }`,
          {
            org: owner,
            // Where to come back to once GitHub is done.
            returnTo: window.location.pathname + window.location.search,
          },
          (d) => d.startGithubConnect,
        );
        if (!res.ok || !res.data) {
          toast.error(res.ok ? "Could not start GitHub connect" : res.error);
          return;
        }
        const { actionUrl, manifest, state } = res.data;
        const form = document.createElement("form");
        form.method = "POST";
        form.action = actionUrl;
        for (const [name, value] of [
          ["manifest", manifest],
          ["state", state],
        ] as const) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
      });
    },
    [startTransition],
  );

  return { connect, pending };
}

/**
 * The owner choice every connect surface shares: GitHub creates the App under
 * whoever owns it, and the two owners live at different addresses on github.com,
 * so it is picked here, before the browser leaves.
 */
export function useGithubOwnerConnect() {
  const { connect, pending } = useGithubConnect();
  const [orgOpen, setOrgOpen] = React.useState(false);

  const items = (
    <>
      <DropdownMenuItem onSelect={() => connect()}>
        <User className="size-4" />
        Personal account
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setOrgOpen(true)}>
        <Building2 className="size-4" />
        Organization
      </DropdownMenuItem>
    </>
  );

  const dialog = orgOpen ? (
    <GithubOrgDialog
      onClose={() => setOrgOpen(false)}
      onConnect={(org) => connect(org)}
    />
  ) : null;

  return { items, dialog, pending, connect };
}

/**
 * GitHub has no API to list the organizations of someone who has not connected
 * yet, so the name is typed once here and becomes the address the manifest is
 * POSTed to. Only members who can create Apps there will get past GitHub.
 */
function GithubOrgDialog({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (org: string) => void;
}) {
  const [org, setOrg] = React.useState("");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <GitProviderMark provider="github" className="size-7" />
            Connect an organization
          </DialogTitle>
          <DialogDescription>
            GitHub asks you to create the App inside the organization you name.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!org.trim()) return;
            onConnect(org.trim());
          }}
        >
          <div className="space-y-2">
            <FieldLabel
              htmlFor="github-org"
              info="The name in the organization's address on github.com, like github.com/acme."
              docs="git.github"
            >
              Organization
            </FieldLabel>
            <Input
              id="github-org"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="acme"
              autoFocus
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!org.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function GithubConnectButton({
  label = "Connect GitHub",
  variant = "default",
  size,
  className,
}: {
  label?: string;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  className?: string;
}) {
  const { items, dialog, pending } = useGithubOwnerConnect();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size={size}
            className={className}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <GitHubIcon className="size-4" />
            )}
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-52">
          {items}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

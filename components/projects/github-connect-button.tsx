"use client";

import * as React from "react";
import { toast } from "sonner";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { startGithubConnectAction } from "@/lib/actions/github";

/**
 * Kicks off GitHub's App Manifest flow: asks the server for a manifest + signed
 * state, then POSTs them to GitHub via a transient form so the browser
 * navigates to GitHub to create (and then install) the App  no manual id/key
 * copy/paste, the way Dokploy does it.
 */
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
  const [pending, startTransition] = React.useTransition();

  function connect() {
    startTransition(async () => {
      const res = await startGithubConnectAction();
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
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={connect}
      disabled={pending}
    >
      <GitHubIcon className="size-4" />
      {pending ? "Redirecting…" : label}
    </Button>
  );
}

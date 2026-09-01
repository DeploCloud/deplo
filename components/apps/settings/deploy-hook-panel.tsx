"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, Copy, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RevealChip } from "@/components/shared/reveal-chip";
import { CommandLine } from "@/components/shared/code-block";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { copyText } from "@/lib/clipboard";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The app's DEPLOY HOOK: one URL that deploys it, for everything that can't click
 * the dashboard - a GitLab or Bitbucket webhook, a CI job that just pushed a new
 * image, a cron on someone's laptop.
 */
export function DeployHookPanel({
  appId,
  enabled: initialEnabled,
  maskedUrl,
}: {
  appId: string;
  enabled: boolean;
  /** The hook URL with its secret segment dotted out - what the covered chip
   * shows, so the shape of the link is legible without revealing it. */
  maskedUrl: string;
}) {
  const [enabled, applyEnabled] = useOptimisticValue(initialEnabled);
  const [url, setUrl] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  /** The real URL, fetched once and kept for the life of the panel. */
  const resolve = React.useCallback(async () => {
    if (url !== null) return url;
    setPending(true);
    const res = await gqlAction<{ revealAppDeployHook: string }, string>(
      `mutation($id: String!) { revealAppDeployHook(id: $id) }`,
      { id: appId },
      (d) => d.revealAppDeployHook,
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    setUrl(res.data ?? null);
    return res.data ?? null;
  }, [appId, url]);

  function toggle(value: boolean) {
    applyEnabled(
      value,
      () =>
        gqlAction(
          `mutation($id: String!, $value: Boolean!) { setAppDeployHookEnabled(id: $id, value: $value) { id } }`,
          { id: appId, value },
        ),
      { success: value ? "Deploy hook enabled" : "Deploy hook disabled" },
    );
  }

  async function rotate() {
    const res = await gqlAction<{ rotateAppDeployHook: string }, string>(
      `mutation($id: String!) { rotateAppDeployHook(id: $id) }`,
      { id: appId },
      (d) => d.rotateAppDeployHook,
    );
    if (res.ok) {
      // Show the new link straight away: the old one is dead from this moment,
      // so whoever rotated it needs the replacement in front of them.
      setUrl(res.data ?? null);
      setRevealed(true);
    }
    return res;
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            Deploy hook
            <InfoTip
              content={
                <>
                  A URL that deploys this app when something POSTs to it - a
                  webhook from your git provider, a CI job, a script. The call
                  also has to carry an API token, so the URL on its own
                  can&apos;t deploy anything.
                </>
              }
              docs="releases.deployHook"
            />
          </p>
          <p className="text-xs text-muted-foreground">
            POST to this URL to deploy the app. Turn it off and every call is
            refused.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          aria-label="Deploy hook"
        />
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        <RevealChip
          className="min-w-0 flex-1"
          placeholder={maskedUrl}
          placeholderClassName="text-muted-foreground/70"
          value={url}
          revealed={revealed}
          pending={pending}
          onToggle={() => {
            if (revealed) {
              setRevealed(false);
              return;
            }
            void resolve().then((v) => {
              if (v !== null) setRevealed(true);
            });
          }}
          labels={{
            reveal: "Reveal deploy hook URL",
            hide: "Hide deploy hook URL",
          }}
        />
        <CopyResolved resolve={resolve} />
        <ConfirmAction
          title="Rotate the deploy hook URL?"
          description="The current URL stops working immediately. Anything already using it (a webhook in your git provider, a CI job) has to be updated with the new one."
          confirmLabel="Rotate URL"
          successMessage="Deploy hook rotated"
          onConfirm={rotate}
          trigger={
            <Button
              variant="outline"
              size="icon-sm"
              className="size-7 shrink-0"
              aria-label="Rotate deploy hook URL"
              title="Rotate deploy hook URL"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          }
        />
      </div>

      {/* The whole call, ready to paste - only once the URL is on screen, so a
          "copy" never hands over a command with dots where the token goes. */}
      {revealed && url && (
        <CommandLine
          command={`curl -X POST -H "Authorization: Bearer deplo_your_token" ${url}`}
        />
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0" />
        <span>
          Calls need an API token that holds <strong>Deploy apps</strong>, sent
          as{" "}
          <code className="font-mono text-[0.7rem]">
            Authorization: Bearer deplo_…
          </code>
          . Create one in{" "}
          <Link
            href="/settings/tokens"
            className="underline underline-offset-2 hover:text-foreground"
          >
            API tokens
          </Link>{" "}
          - the <strong>Deploy hook &amp; CI</strong> template is exactly this.
          Revoking it stops every hook call made with it.
        </span>
      </p>
    </div>
  );
}

/** Copy the URL, fetching it first when it hasn't been revealed, so it can go
 * to the clipboard without ever going on screen. */
function CopyResolved({ resolve }: { resolve: () => Promise<string | null> }) {
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    setBusy(true);
    const v = await resolve();
    setBusy(false);
    if (v === null) return; // resolve() already said why
    if (!(await copyText(v))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <SimpleTooltip content={copied ? "Copied" : "Copy deploy hook URL"}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Copy deploy hook URL"
        disabled={busy}
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={copy}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : copied ? (
          <Check className="size-3.5 text-[var(--success)]" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </SimpleTooltip>
  );
}

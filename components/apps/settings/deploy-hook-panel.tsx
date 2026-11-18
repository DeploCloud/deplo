"use client";

import { Bone } from "@/components/ui/skeleton";
import { useSettingsLoading } from "@/components/apps/settings/settings-loading";
import * as React from "react";
import Link from "@/components/ui/link";
import { toast } from "sonner";
import { RefreshCw, ShieldCheck, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { RevealChip } from "@/components/shared/reveal-chip";
import { CommandLine } from "@/components/shared/code-block";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { gqlAction } from "@/lib/graphql-client";

export function DeployHookPanel({
  appId,
  enabled: initialEnabled,
  maskedUrl,
}: {
  appId: string;
  enabled: boolean;
  maskedUrl: string;
}) {
  const loading = useSettingsLoading();
  const [enabled, applyEnabled] = useOptimisticValue(initialEnabled);
  const [url, setUrl] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [pending, setPending] = React.useState(false);

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
      setUrl(res.data ?? null);
      setRevealed(true);
    }
    return res;
  }

  return (
    <FeatureRow
      icon={Webhook}
      title="Deploy hook"
      info="Deploys this app when a git webhook, a CI job or a script calls it. The call also needs an API token, so the URL alone deploys nothing."
      docs="releases.deployHook"
      description="POST to this URL to deploy the app. Turn it off and every call is refused."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          aria-label="Deploy hook"
        />
      }
    >
      <div className="mt-4 space-y-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Bone box loading={loading} className="min-w-0 flex-1">
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
              onCopy={resolve}
              copyLabel="Copy deploy hook URL"
              labels={{
                reveal: "Reveal deploy hook URL",
                hide: "Hide deploy hook URL",
              }}
            />
          </Bone>
          <ConfirmAction
            title="Rotate the deploy hook URL?"
            description="The current URL stops working immediately."
            consequence="Anything already using it - a git webhook, a CI job - has to be updated with the new one."
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

        {revealed && url && (
          <CommandLine
            command={`curl -X POST -H "Authorization: Bearer deplo_your_token" ${url}`}
          />
        )}

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="mt-px size-3.5 shrink-0" />
          <span>
            Calls need an API token that holds <strong>Deploy apps</strong>.
            Create one in{" "}
            <Link
              href="/settings/tokens"
              className="underline underline-offset-2 hover:text-foreground"
            >
              API tokens
            </Link>{" "}
            - the <strong>Deploy hook &amp; CI</strong> template is exactly
            this.
          </span>
        </p>
      </div>
    </FeatureRow>
  );
}

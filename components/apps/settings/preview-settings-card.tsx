"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

/**
 * Settings → Deployments → Pull request previews.
 *
 * ONE visible switch. Everything else is behind Advanced, on purpose: a preview
 * URL, a limit and an idle timeout all have answers that are right for almost
 * everyone, and putting them on the first-run path would tax the one thing that
 * makes self-hosting worth it. The switch is off by default because a preview is
 * a container on the operator's own server.
 */
export function PreviewSettingsCard({
  appId,
  branch,
  enabled: initialEnabled,
  baseDomain: initialBaseDomain,
  maxActive: initialMaxActive,
  ttlDays: initialTtlDays,
  forkPolicy: initialForkPolicy,
}: {
  appId: string;
  branch: string;
  enabled: boolean;
  baseDomain: string | null;
  maxActive: number;
  ttlDays: number;
  forkPolicy: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [baseDomain, setBaseDomain] = React.useState(initialBaseDomain ?? "");
  const [maxActive, setMaxActive] = React.useState(String(initialMaxActive));
  const [ttlDays, setTtlDays] = React.useState(String(initialTtlDays));
  const [forkPolicy, setForkPolicy] = React.useState(initialForkPolicy);

  const advancedDirty =
    baseDomain !== (initialBaseDomain ?? "") ||
    maxActive !== String(initialMaxActive) ||
    ttlDays !== String(initialTtlDays) ||
    forkPolicy !== initialForkPolicy;

  function save(
    input: Record<string, unknown>,
    success: string,
    revert?: () => void,
  ) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($appId: ID!, $input: AppPreviewSettingsInput!) {
          setAppPreviewSettings(appId: $appId, input: $input)
        }`,
        { appId, input },
      );
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else {
        revert?.();
        toast.error(res.error);
      }
    });
  }

  function toggle(v: boolean) {
    setEnabled(v);
    save(
      { enabled: v },
      v ? "Pull request previews are on" : "Pull request previews are off",
      () => setEnabled(!v),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Pull request previews
          <InfoTip
            content={`Every pull request opened against ${branch} gets its own deploy with its own URL, torn down when the pull request closes. Deplo posts the link on the pull request.`}
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Deploy pull requests</p>
            <p className="text-xs text-muted-foreground">
              Each open pull request gets its own preview and URL.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={toggle} disabled={pending} />
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")}
          />
          Advanced
        </button>

        {advancedOpen && (
          <div className="grid gap-4 rounded-lg border border-border p-3">
            <div className="grid gap-1.5">
              <FieldLabel
                htmlFor="preview-base-domain"
                info="Leave empty and each preview gets a working nip.io address with no DNS setup, served over plain HTTP. Set a domain like preview.example.com, point a wildcard DNS record at this server, and each preview gets a real HTTPS URL with its own certificate."
              >
                Preview domain
              </FieldLabel>
              <Input
                id="preview-base-domain"
                value={baseDomain}
                onChange={(e) => setBaseDomain(e.target.value)}
                placeholder="preview.example.com"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <FieldLabel
                  htmlFor="preview-max-active"
                  info="How many previews of this app may run at once. Over the limit, a new pull request is told why instead of a running preview being destroyed to make room."
                >
                  Live previews
                </FieldLabel>
                <Input
                  id="preview-max-active"
                  type="number"
                  min={1}
                  max={50}
                  value={maxActive}
                  onChange={(e) => setMaxActive(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <FieldLabel
                  htmlFor="preview-ttl"
                  info="Days without activity on a pull request before Deplo destroys its preview. Any new commit resets the clock, so an active pull request never expires."
                >
                  Destroy after
                </FieldLabel>
                <Input
                  id="preview-ttl"
                  type="number"
                  min={1}
                  max={365}
                  value={ttlDays}
                  onChange={(e) => setTtlDays(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <FieldLabel
                htmlFor="preview-fork-policy"
                info="A pull request from a fork is code you do not control, running on your server. By default it appears in the list and waits for someone with deploy access to approve it. A fork preview never receives this app's secret variables, whichever option you pick."
              >
                Fork pull requests
              </FieldLabel>
              <Select value={forkPolicy} onValueChange={setForkPolicy}>
                <SelectTrigger id="preview-fork-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approve">Wait for approval</SelectItem>
                  <SelectItem value="deny">Ignore them</SelectItem>
                  <SelectItem value="allow">Build them automatically</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={pending || !advancedDirty}
                onClick={() =>
                  save(
                    {
                      baseDomain: baseDomain.trim(),
                      maxActive: Number(maxActive) || null,
                      ttlDays: Number(ttlDays) || null,
                      forkPolicy,
                    },
                    "Preview settings saved",
                  )
                }
              >
                <Save className="size-4" />
                Save preview settings
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

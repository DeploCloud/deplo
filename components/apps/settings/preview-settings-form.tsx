"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import { SettingRow } from "@/components/shared/setting-row";
import { gqlAction } from "@/lib/graphql-client";
import { ConsequenceNote } from "@/components/shared/confirm-action";

export interface PreviewSettingsFormProps {
  appId: string;
  branch: string;
  enabled: boolean;
  baseDomain: string | null;
  https: boolean;
  maxActive: number;
  ttlDays: number;
  forkPolicy: string;
  serverId: string | null;
  autoDeploy: boolean;
  port: number | null;
  buildDrafts: boolean;
  comment: boolean;
  requiredLabels: string[];
  appServerId: string;
  appPort: number;
  servers: { id: string; name: string; isDeploHost: boolean }[];
  activeCount: number;
}

export function PreviewSettingsForm(props: PreviewSettingsFormProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(props.enabled);
  const [confirmOff, setConfirmOff] = React.useState(false);

  const initial = React.useMemo(
    () => ({
      baseDomain: props.baseDomain ?? "",
      https: props.https,
      maxActive: String(props.maxActive),
      ttlDays: String(props.ttlDays),
      forkPolicy: props.forkPolicy,
      serverId: props.serverId ?? "",
      autoDeploy: props.autoDeploy,
      port: props.port ? String(props.port) : "",
      buildDrafts: props.buildDrafts,
      comment: props.comment,
      requiredLabels: props.requiredLabels.join("\n"),
    }),
    [props],
  );
  const [form, setForm] = React.useState(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const canHttps = form.baseDomain.trim() !== "";

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($appId: ID!, $input: AppPreviewSettingsInput!) {
          setAppPreviewSettings(appId: $appId, input: $input)
        }`,
        {
          appId: props.appId,
          input: {
            baseDomain: form.baseDomain.trim(),
            https: canHttps && form.https,
            maxActive: Number(form.maxActive) || null,
            ttlDays: Number(form.ttlDays) || null,
            forkPolicy: form.forkPolicy,
            serverId: form.serverId,
            autoDeploy: form.autoDeploy,
            port: Number(form.port) || null,
            buildDrafts: form.buildDrafts,
            comment: form.comment,
            requiredLabels: form.requiredLabels,
          },
        },
      );
      if (res.ok) {
        toast.success("Pull request settings saved");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function apply(v: boolean) {
    setEnabled(v);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($appId: ID!, $input: AppPreviewSettingsInput!) {
          setAppPreviewSettings(appId: $appId, input: $input)
        }`,
        { appId: props.appId, input: { enabled: v } },
      );
      if (res.ok) {
        toast.success(
          v ? "Pull request previews are on" : "Pull request previews are off",
        );
        router.refresh();
      } else {
        setEnabled(!v);
        toast.error(res.error);
      }
    });
  }

  function toggle(v: boolean) {
    if (!v && props.activeCount > 0) return setConfirmOff(true);
    apply(v);
  }

  const serverName =
    props.servers.find((s) => s.id === props.appServerId)?.name ?? "";

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium">
                Deploy pull requests
                <Badge variant="info" className="text-[10px] font-normal">
                  Beta
                </Badge>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Every pull request opened against{" "}
                <span className="font-mono">{props.branch}</span> gets its own
                deploy and its own URL. Still new - expect the odd rough edge,
                and tell us about it.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={toggle}
              disabled={pending}
              aria-label="Deploy pull requests"
            />
          </div>
        </CardContent>
      </Card>

      <fieldset disabled={!enabled} className="contents">
        <div className={enabled ? "space-y-4" : "space-y-4 opacity-50"}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                How previews are built
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-1.5">
                <FieldLabel
                  htmlFor="pv-domain"
                  info="Empty gives every preview a working nip.io address, no DNS needed. Set your own domain and point a wildcard record at this server."
                  docs="previews.settings"
                >
                  Preview domain
                </FieldLabel>
                <Input
                  id="pv-domain"
                  value={form.baseDomain}
                  onChange={(e) => set("baseDomain", e.target.value)}
                  placeholder="preview.example.com"
                  spellCheck={false}
                />
              </div>

              <SettingRow
                label="HTTPS"
                htmlFor="pv-https"
                info="Give every preview its own certificate. Needs a preview domain - a nip.io address can never hold one."
                docs="previews.settings"
              >
                <div className="flex items-center gap-3">
                  {!canHttps && (
                    <span className="text-xs text-muted-foreground">
                      Set a preview domain first
                    </span>
                  )}
                  <Switch
                    id="pv-https"
                    checked={canHttps && form.https}
                    onCheckedChange={(v) => set("https", v)}
                    disabled={!canHttps}
                  />
                </div>
              </SettingRow>

              <SettingRow
                label="Rebuild on every commit"
                htmlFor="pv-auto"
                info="Off, a preview is built once and only Redeploy refreshes it - what a heavy image or a metered builder wants."
                docs="previews.settings"
              >
                <Switch
                  id="pv-auto"
                  checked={form.autoDeploy}
                  onCheckedChange={(v) => set("autoDeploy", v)}
                />
              </SettingRow>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <FieldLabel
                    htmlFor="pv-max"
                    info="How many previews run at once. At the limit, a new pull request replaces the one nobody has touched in the longest, and Redeploy brings it back."
                    docs="previews.limit"
                  >
                    Live previews
                  </FieldLabel>
                  <Input
                    id="pv-max"
                    type="number"
                    min={1}
                    max={50}
                    value={form.maxActive}
                    onChange={(e) => set("maxActive", e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <FieldLabel
                    htmlFor="pv-port"
                    info={`The port a preview answers on. Empty means the app's own (${props.appPort}), which keeps a preview faithful to production.`}
                    docs="previews.settings"
                  >
                    Port
                  </FieldLabel>
                  <Input
                    id="pv-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(e) => set("port", e.target.value)}
                    placeholder={`Same as the app (${props.appPort})`}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <Accordion type="single" collapsible>
              <AccordionItem value="advanced" className="border-none">
                <AccordionTrigger className="px-6 text-sm hover:no-underline">
                  Advanced
                </AccordionTrigger>
                <AccordionContent className="space-y-4 px-6 pb-6">
                  <div className="grid gap-1.5">
                    <FieldLabel
                      htmlFor="pv-labels"
                      info="One label per line. With any label here, only pull requests carrying one get a preview. Empty means every pull request qualifies."
                      docs="previews.settings"
                    >
                      Only pull requests labelled
                    </FieldLabel>
                    <Textarea
                      id="pv-labels"
                      value={form.requiredLabels}
                      onChange={(e) => set("requiredLabels", e.target.value)}
                      placeholder={"preview\ndeploy-me"}
                      rows={3}
                      spellCheck={false}
                      className="font-mono text-sm"
                    />
                  </div>

                  <SettingRow
                    label="Build drafts"
                    htmlFor="pv-drafts"
                    info="Off, a draft pull request waits until it is marked ready for review. Deploy a pull request by hand covers the exception."
                    docs="previews.settings"
                  >
                    <Switch
                      id="pv-drafts"
                      checked={form.buildDrafts}
                      onCheckedChange={(v) => set("buildDrafts", v)}
                    />
                  </SettingRow>

                  <SettingRow
                    label="Comment on the pull request"
                    htmlFor="pv-comment"
                    info="Posts the preview URL as one comment, kept up to date. Needs the Pull requests: write permission on your GitHub App."
                    docs="previews.settings"
                  >
                    <Switch
                      id="pv-comment"
                      checked={form.comment}
                      onCheckedChange={(v) => set("comment", v)}
                    />
                  </SettingRow>

                  <div className="grid gap-1.5">
                    <FieldLabel
                      htmlFor="pv-ttl"
                      info="Days without activity on a pull request before Deplo destroys its preview. Any new commit resets the clock, so an active pull request never expires."
                      docs="previews.settings"
                    >
                      Destroy after
                    </FieldLabel>
                    <Input
                      id="pv-ttl"
                      type="number"
                      min={1}
                      max={365}
                      value={form.ttlDays}
                      onChange={(e) => set("ttlDays", e.target.value)}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <FieldLabel
                      htmlFor="pv-fork"
                      info="A fork's code is not yours, and it runs on your server. A fork preview never receives this app's secret variables."
                      docs="previews.forksAndSecrets"
                    >
                      Fork pull requests
                    </FieldLabel>
                    <Select
                      value={form.forkPolicy}
                      onValueChange={(v) => set("forkPolicy", v)}
                    >
                      <SelectTrigger id="pv-fork">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approve">
                          Wait for approval
                        </SelectItem>
                        <SelectItem value="deny">Ignore them</SelectItem>
                        <SelectItem value="allow">
                          Build them automatically
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-1.5">
                    <FieldLabel
                      htmlFor="pv-server"
                      info="Which server runs the previews. The app's own is the honest default; a spare machine keeps pull request builds off the box serving your users."
                      docs="previews.settings"
                    >
                      Server
                    </FieldLabel>
                    <Select
                      value={form.serverId || "__app__"}
                      onValueChange={(v) =>
                        set("serverId", v === "__app__" ? "" : v)
                      }
                    >
                      <SelectTrigger id="pv-server">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__app__">
                          Same as the app{serverName ? ` (${serverName})` : ""}
                        </SelectItem>
                        {props.servers
                          .filter((s) => s.id !== props.appServerId)
                          .map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              <span className="flex items-center gap-2">
                                {s.name}
                                <ServerRoleHint isDeploHost={s.isDeploHost} />
                              </span>
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <CardFooter className="justify-between border-t border-border pt-4">
              <DirtyHint dirty={dirty} />
              <Button size="sm" onClick={save} disabled={pending || !dirty}>
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save
              </Button>
            </CardFooter>
          </Card>
        </div>
      </fieldset>

      <UnsavedChangesGuard when={dirty} />

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off pull request previews?</DialogTitle>
            <DialogDescription className="mt-1">
              Open pull requests stop getting a preview.
            </DialogDescription>
          </DialogHeader>
          <ConsequenceNote>
            {props.activeCount === 1
              ? "The 1 preview running now is destroyed, along with its data."
              : `The ${props.activeCount} previews running now are destroyed, along with their data.`}
          </ConsequenceNote>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOff(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setConfirmOff(false);
                apply(false);
              }}
            >
              Turn off and destroy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

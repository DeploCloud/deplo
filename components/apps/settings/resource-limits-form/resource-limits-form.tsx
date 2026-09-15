"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import { Save, RotateCcw, Cpu } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import type { ResourceLimits } from "@/lib/types/container";
import {
  type ResourceLimitsForm as FormState,
  type ResourceSize,
  EMPTY_RESOURCE_FORM,
  resourcesToForm,
  formToLimitsInput,
  serializeResourceForm,
} from "@/lib/apps/resource-limits-model";
import { gqlAction } from "@/lib/graphql-client";
import { AdvancedLimits } from "./advanced-limits";
import { HeadlineLimits } from "./headline-limits";
import { SizeTiles, type HostInfo } from "./host-capacity";
import { useLiveUsage, type UsageSample } from "./use-live-usage";

export function ResourceLimitsForm({
  kind,
  id,
  slug,
  resources,
  isComposeStack = false,
  host,
  usage,
  canRedeploy,
  canProtectFromOom,
}: {
  kind: "app" | "database";
  id: string;
  slug?: string;
  resources: ResourceLimits | null;
  isComposeStack?: boolean;
  host: HostInfo | null;
  usage: UsageSample[] | null;
  canRedeploy: boolean;
  canProtectFromOom: boolean;
}) {
  const router = useRouter();
  const noun = kind === "app" ? "app" : "database";
  const [form, setForm] = React.useState<FormState>(() =>
    resourcesToForm(resources),
  );
  const [pending, startTransition] = React.useTransition();
  const [savedKey, setSavedKey] = React.useState(() =>
    serializeResourceForm(resourcesToForm(resources)),
  );
  const dirty = serializeResourceForm(form) !== savedKey;

  const set = (k: keyof FormState) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setSize = (s: ResourceSize | null) =>
    setForm((f) => ({
      ...f,
      memoryMb: s ? String(s.memoryMb) : "",
      cpuCores: s ? String(s.cpuCores) : "",
    }));

  const live = useLiveUsage({ kind, id, usage });

  const hostCap =
    host && (host.memoryMb > 0 || host.cpuCores > 0) ? host : null;

  function applyNow() {
    startTransition(async () => {
      if (kind === "app") {
        const res = await gqlAction<
          { redeploy: { id: string | null } | null },
          { id: string | null } | null
        >(
          `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
          { appId: id },
          (d) => d.redeploy,
        );
        if (!res.ok) return void toast.error(res.error);
        toast.success("Deploy started");
        if (res.data?.id && slug)
          router.push(`/apps/${slug}/deployments/${res.data.id}`);
        else router.refresh();
      } else {
        const res = await gqlAction(
          `mutation($id: String!) { redeployDatabase(id: $id) { id } }`,
          { id },
        );
        if (!res.ok) return void toast.error(res.error);
        toast.success("Database redeployed");
        router.refresh();
      }
    });
  }

  function save() {
    const committed = serializeResourceForm(form);
    const mutation =
      kind === "app" ? "updateAppResources" : "updateDatabaseResources";
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $limits: ResourceLimitsInput!) {
           ${mutation}(id: $id, limits: $limits) { id }
         }`,
        { id, limits: formToLimitsInput(form) },
      );
      if (!res.ok) return void toast.error(res.error);
      setSavedKey(committed);
      router.refresh();
      toast.success(
        kind === "app"
          ? "Resource limits saved - applied on the next deploy"
          : "Resource limits saved - Redeploy to apply",
        canRedeploy
          ? {
              action: {
                label: kind === "app" ? "Deploy now" : "Redeploy now",
                onClick: applyNow,
              },
            }
          : undefined,
      );
    });
  }

  const clearDisabled =
    pending ||
    serializeResourceForm(form) === serializeResourceForm(EMPTY_RESOURCE_FORM);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4 text-muted-foreground" />
            Resource limits
          </CardTitle>
          <CardDescription>
            {isComposeStack ? (
              <>
                Cap how much of the host each service of this stack can use.
                Empty means no limit; a service&apos;s own compose limit wins.
              </>
            ) : (
              <>
                Cap how much of the host this {noun} can use. Empty means no
                limit.
              </>
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          <SizeTiles form={form} hostCap={hostCap} onSelect={setSize} />

          <HeadlineLimits
            form={form}
            set={set}
            hostCap={hostCap}
            usage={live}
            noun={noun}
            onApplySuggestion={setSize}
          />

          <AdvancedLimits
            form={form}
            set={set}
            canProtectFromOom={canProtectFromOom}
          />
        </CardContent>

        <CardFooter className="justify-between border-t border-border pt-4">
          <DirtyHint dirty={dirty} />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setForm({ ...EMPTY_RESOURCE_FORM })}
              disabled={clearDisabled}
            >
              <RotateCcw className="size-4" />
              Clear all
            </Button>
            <Button size="sm" onClick={save} disabled={pending || !dirty}>
              <Save className="size-4" />
              Save limits
            </Button>
          </div>
        </CardFooter>
      </Card>

      <UnsavedChangesGuard when={dirty} />
    </>
  );
}

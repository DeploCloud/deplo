"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  Cable,
  GitPullRequest,
  Network,
  Timer,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DocsLink } from "@/components/ui/docs-link";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { gqlAction } from "@/lib/graphql-client";
import { EXPERIMENT_META, type ExperimentKey } from "@/lib/experiments";
import type { DocsTopic } from "@/lib/docs";
import type { ExperimentState } from "@/lib/data/experiments";

const ICON: Record<
  ExperimentKey,
  React.ComponentType<{ className?: string }>
> = {
  crons: Timer,
  zeroDowntime: ArrowLeftRight,
  pullRequests: GitPullRequest,
  clusters: Network,
  tunnels: Cable,
};

const DOCS: Record<ExperimentKey, DocsTopic> = {
  crons: "cron.overview",
  zeroDowntime: "deploy.zeroDowntime",
  pullRequests: "previews.overview",
  clusters: "clusters.overview",
  tunnels: "panel.tunnel",
};

// What a pause stops. Clusters and tunnels never get here: they refuse while in use.
const PAUSE: Partial<Record<ExperimentKey, string>> = {
  crons: "No cron job runs until it is turned back on.",
  zeroDowntime:
    "Deploys replace the running version in place, with a short gap.",
  pullRequests:
    "New pull requests get no preview, and pushes no longer update the live ones.",
};

export function ExperimentsTab({ states }: { states: ExperimentState[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Features that are still new. Turning one on offers it to every team.{" "}
        <DocsLink topic="instance.experiments" />
      </p>
      <Card className="divide-y divide-border">
        {states.map((s) => (
          <ExperimentRow key={s.key} initial={s} />
        ))}
      </Card>
    </div>
  );
}

function ExperimentRow({ initial }: { initial: ExperimentState }) {
  const router = useRouter();
  const [state, setState] = React.useState(initial);
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const { label, description } = EXPERIMENT_META[state.key];
  const id = `experiment-${state.key}`;
  const locked = state.enabled && state.lockedOn != null;

  async function save(enabled: boolean) {
    const res = await gqlAction<{ setExperiment: ExperimentState }>(
      /* GraphQL */ `
        mutation SetExperiment($key: ExperimentKey!, $enabled: Boolean!) {
          setExperiment(key: $key, enabled: $enabled) {
            key
            enabled
            usage
            lockedOn
          }
        }
      `,
      { key: state.key, enabled },
    );
    if (res.ok && res.data) {
      setState(res.data.setExperiment);
      router.refresh();
    }
    return res;
  }

  function toggle(next: boolean) {
    if (!next && state.usage) return setConfirming(true);
    startTransition(async () => {
      const res = await save(next);
      if (res.ok) toast.success(`${label} turned ${next ? "on" : "off"}`);
      else toast.error(res.error);
    });
  }

  const control = (
    <div className="flex items-center gap-3">
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        {state.usage ?? "Not in use"}
      </span>
      <Switch
        id={id}
        checked={state.enabled}
        disabled={pending || locked}
        onCheckedChange={toggle}
      />
    </div>
  );

  return (
    <SettingItem
      icon={ICON[state.key]}
      title={label}
      htmlFor={id}
      docs={DOCS[state.key]}
      description={description}
      control={
        locked ? (
          <SimpleTooltip content={state.lockedOn}>
            <span className="inline-flex">{control}</span>
          </SimpleTooltip>
        ) : (
          control
        )
      }
    >
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={`Turn off ${label}?`}
        description={
          <>
            It is used by <strong>{state.usage}</strong>. Each keeps its own
            setting, so turning it back on picks up where it left off.
          </>
        }
        consequence={PAUSE[state.key]}
        confirmLabel="Turn off"
        successMessage={`${label} turned off`}
        onConfirm={() => save(false)}
      />
    </SettingItem>
  );
}

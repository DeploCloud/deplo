"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { HeartPulse } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";

const SET = /* GraphQL */ `
  mutation ($id: String!, $value: Boolean!) {
    setAppRestartWhenUnresponsive(id: $id, value: $value) {
      id
    }
  }
`;

export function RestartWhenUnresponsiveForm({
  appId,
  enabled: initial,
  paused,
  needsNewerAgent,
}: {
  appId: string;
  enabled: boolean;
  paused: boolean;
  needsNewerAgent: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initial);

  function apply(v: boolean) {
    setEnabled(v);
    startTransition(async () => {
      const res = await gqlAction(SET, { id: appId, value: v });
      if (res.ok) {
        toast.success(
          v
            ? "Deplo will restart this app when it stops answering"
            : "Deplo will leave this app alone when it stops answering",
        );
        router.refresh();
      } else {
        setEnabled(!v);
        toast.error(res.error);
      }
    });
  }

  return (
    <FeatureRow
      id="restart-when-unresponsive"
      icon={HeartPulse}
      title="Restart when it stops answering"
      info="Turn it off for an app that is meant to be slow to answer. Applies from the next deploy."
      docs="health.overview"
      description={
        needsNewerAgent
          ? "Automatic restart needs a newer server agent. Deplo updates it on its own."
          : paused
            ? "Not answering · restarts paused. It resumes after your next deploy, a manual restart, or 30 quiet minutes."
            : "Restarts the app after 3 failed checks in a row."
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Restart when it stops answering"
        />
      }
    />
  );
}

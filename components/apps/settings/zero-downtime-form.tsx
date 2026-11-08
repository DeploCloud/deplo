"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ArrowLeftRight } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { BetaChip } from "@/components/shared/beta-chip";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";

const SET = /* GraphQL */ `
  mutation ($id: String!, $value: Boolean!) {
    setAppZeroDowntimeDeploys(id: $id, value: $value) {
      id
    }
  }
`;

export function ZeroDowntimeForm({
  appId,
  enabled: initial,
}: {
  appId: string;
  enabled: boolean;
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
          v ? "Zero-downtime deploys are on" : "Zero-downtime deploys are off",
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
      id="zero-downtime"
      icon={ArrowLeftRight}
      title="Zero-downtime deploys"
      badge={<BetaChip />}
      info="Two copies of the app run for a moment and share its storage. One that cannot share it goes offline briefly instead."
      docs="deploy.zeroDowntime"
      description="Keeps the old version online until the new one is ready."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Zero-downtime deploys"
        />
      }
    />
  );
}

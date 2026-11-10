"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { UserRoundCheck } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";

const SET = /* GraphQL */ `
  mutation ($id: String!, $value: Boolean!) {
    setAppStickySessions(id: $id, value: $value) {
      id
    }
  }
`;

export function StickySessionsForm({
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
          v
            ? "Each visitor stays on the same replica"
            : "Visitors are shared between replicas",
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
      id="sticky-sessions"
      icon={UserRoundCheck}
      title="Keep each visitor on the same replica"
      info="For an app that remembers a visitor in its own memory. Uses a cookie."
      docs="deploy.replicas"
      description="Applies from the next deploy."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Keep each visitor on the same replica"
        />
      }
    />
  );
}

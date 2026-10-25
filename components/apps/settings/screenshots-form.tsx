"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Camera } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";

const SET = /* GraphQL */ `
  mutation ($id: String!, $value: Boolean!) {
    setAppScreenshots(id: $id, value: $value) {
      id
    }
  }
`;

export function ScreenshotsForm({
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
        toast.success(v ? "Screenshots are on" : "Screenshots are off");
        router.refresh();
      } else {
        setEnabled(!v);
        toast.error(res.error);
      }
    });
  }

  return (
    <FeatureRow
      id="screenshots"
      icon={Camera}
      title="Deployment screenshots"
      info="Taken in a private browser on the app's server. Turning it off deletes the saved ones."
      docs="deploy.screenshot"
      description="Shows a picture of the site after each deploy."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Deployment screenshots"
        />
      }
    />
  );
}

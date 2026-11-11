"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { CopyPlus } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseStandby } from "@/lib/data/databases/standby";

const SET = /* GraphQL */ `
  mutation ($id: String!, $enabled: Boolean!) {
    setDatabaseStandby(id: $id, enabled: $enabled) {
      id
    }
  }
`;

export function DatabaseStandbyForm({
  databaseId,
  standby,
  disabled,
}: {
  databaseId: string;
  standby: DatabaseStandby;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(standby.enabled);

  function apply(v: boolean) {
    setEnabled(v);
    startTransition(async () => {
      const res = await gqlAction(SET, { id: databaseId, enabled: v });
      if (res.ok) {
        toast.success(
          v
            ? "A standby copy is being made on another server"
            : "The standby copy was removed",
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
      id="standby"
      icon={CopyPlus}
      title="Keep a standby copy"
      info="A second server runs a copy that follows every change. When this one stops, the copy takes over and about a second of writes is lost."
      docs="clusters.standby"
      description={
        !enabled && standby.unavailable
          ? standby.unavailable
          : standby.note
            ? `${standby.note} ${standby.cost}`
            : standby.cost
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={
            pending || disabled || (!enabled && standby.unavailable != null)
          }
          aria-label="Keep a standby copy"
        />
      }
    />
  );
}

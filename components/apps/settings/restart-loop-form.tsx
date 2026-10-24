"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";

const SET_APP = /* GraphQL */ `
  mutation ($id: String!, $value: Boolean!) {
    setAppRestartLoopGuard(id: $id, value: $value) {
      id
    }
  }
`;

const SET_DATABASE = /* GraphQL */ `
  mutation ($id: String!, $value: Boolean!) {
    setDatabaseRestartLoopGuard(id: $id, value: $value)
  }
`;

export function RestartLoopForm({
  targetKind,
  targetId,
  enabled: initial,
}: {
  targetKind: "app" | "database";
  targetId: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initial);

  function apply(v: boolean) {
    setEnabled(v);
    startTransition(async () => {
      const res = await gqlAction(
        targetKind === "app" ? SET_APP : SET_DATABASE,
        {
          id: targetId,
          value: v,
        },
      );
      if (res.ok) {
        toast.success(
          v
            ? "Restart loop protection is on"
            : "Restart loop protection is off",
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
      id="restart-loop"
      icon={RotateCw}
      title="Restart loop protection"
      info="A container that crashes and restarts forever burns the server's CPU and fills its disk with logs."
      docs="logs.overview"
      description="Stops the container after 10 restarts in 30 minutes."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Restart loop protection"
        />
      }
    />
  );
}

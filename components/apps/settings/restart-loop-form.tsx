"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
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
    <div id="restart-loop" className="scroll-mt-20 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-56 flex-1 space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <RotateCw className="size-4 text-muted-foreground" />
            Restart loop protection
            <InfoTip
              content="A container that crashes and restarts forever burns the server's CPU and fills its disk with logs."
              docs="logs.overview"
            />
          </p>
          <p className="text-sm text-muted-foreground">
            Stops the container after 10 restarts in 30 minutes.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Restart loop protection"
        />
      </div>
    </div>
  );
}

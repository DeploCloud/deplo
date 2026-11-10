"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Layers } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";
import { MAX_REPLICAS, REPLICAS_AGENT_MESSAGE } from "@/lib/deploy/replicas";

const SET = /* GraphQL */ `
  mutation ($id: String!, $value: Int!) {
    setAppReplicas(id: $id, value: $value) {
      id
    }
  }
`;

const COUNTS = Array.from({ length: MAX_REPLICAS }, (_, i) => i + 1);

export function ReplicasForm({
  appId,
  replicas: initial,
  refusal,
  agentTooOld,
}: {
  appId: string;
  replicas: number;
  // Why more than one copy is refused for this app right now, or null.
  refusal: string | null;
  agentTooOld: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [replicas, setReplicas] = React.useState(initial);

  function apply(value: string) {
    const next = Number(value);
    const before = replicas;
    setReplicas(next);
    startTransition(async () => {
      const res = await gqlAction(SET, { id: appId, value: next });
      if (res.ok) {
        toast.success(
          next === 1 ? "Running one copy" : `Running ${next} copies`,
        );
        router.refresh();
      } else {
        setReplicas(before);
        toast.error(res.error);
      }
    });
  }

  const blocked = refusal ?? (agentTooOld ? REPLICAS_AGENT_MESSAGE : null);

  return (
    <FeatureRow
      id="replicas"
      icon={Layers}
      title="Replicas"
      info="Copies of the app on this server, with visitors shared between them."
      docs="deploy.replicas"
      description={
        blocked ??
        "A deploy briefly uses twice the memory while the new copies start."
      }
      control={
        <Select
          value={String(replicas)}
          onValueChange={apply}
          disabled={pending || (blocked != null && replicas === 1)}
        >
          <SelectTrigger className="w-24" aria-label="Replicas">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COUNTS.map((n) => (
              <SelectItem
                key={n}
                value={String(n)}
                disabled={blocked != null && n > 1}
              >
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

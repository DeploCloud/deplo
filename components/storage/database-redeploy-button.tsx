"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Re-render the database's compose from its current settings and reroute it —
 * the "apply my pending edits" verb, and the migration path that stamps the
 * deplo.* labels onto containers provisioned before they existed (enabling
 * logs / terminal / the runtime poll). Honest tooltip: brief downtime, data
 * volume preserved.
 */
export function DatabaseRedeployButton({
  id,
  variant = "default",
  size = "sm",
}: {
  id: string;
  variant?: "outline" | "default" | "secondary";
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function redeploy() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { redeployDatabase(id: $id) { id } }`,
        { id },
      );
      if (res.ok) {
        toast.success("Database redeployed");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <SimpleTooltip content="Re-apply settings by recreating the container — brief downtime, data volume preserved">
      <Button variant={variant} size={size} onClick={redeploy} disabled={pending}>
        <RotateCcw className={pending ? "size-4 animate-spin" : "size-4"} />
        {pending ? "Redeploying…" : "Redeploy"}
      </Button>
    </SimpleTooltip>
  );
}

"use client";

import * as React from "react";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { redeployAction } from "@/lib/actions/projects";

export function RedeployButton({
  projectId,
  variant = "outline",
  size = "sm",
}: {
  projectId: string;
  variant?: "outline" | "default" | "secondary";
  size?: "sm" | "default";
}) {
  const [pending, startTransition] = React.useTransition();

  function redeploy() {
    startTransition(async () => {
      const res = await redeployAction(projectId);
      if (res.ok) toast.success("Redeploy started");
      else toast.error(res.error);
    });
  }

  return (
    <Button variant={variant} size={size} onClick={redeploy} disabled={pending}>
      <RotateCw className={pending ? "size-4 animate-spin" : "size-4"} />
      {pending ? "Redeploying…" : "Redeploy"}
    </Button>
  );
}

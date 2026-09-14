"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { CapabilityTip } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";

// RollbackDialog - the shared confirm for putting an app back on a build it ran.
export function RollbackDialog({
  open,
  onOpenChange,
  id,
  appSlug,
  commitSha,
  commitMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string;
  appSlug: string;
  commitSha?: string;
  commitMessage?: string;
}) {
  const router = useRouter();

  async function rollback() {
    const res = await gqlAction<
      { rollbackDeployment: { id: string | null } | null },
      { id: string | null } | null
    >(
      `mutation ($deploymentId: String!) { rollbackDeployment(deploymentId: $deploymentId) { id } }`,
      { deploymentId: id },
      (d) => d.rollbackDeployment,
    );
    if (res.ok) {
      if (res.data?.id)
        router.push(`/apps/${appSlug}/deployments/${res.data.id}`);
      else router.refresh();
    }
    return res;
  }

  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title="Roll back to this deployment?"
      description={
        <>
          The app goes back to the image this deployment built
          {commitSha ? (
            <>
              {" ("}
              <span className="font-mono">{commitSha.slice(0, 7)}</span>
              {commitMessage ? ` ${commitMessage}` : ""}
              {")"}
            </>
          ) : null}
          . <strong>Only the code goes back</strong>, and nothing is rebuilt.{" "}
          <DocsLink topic="releases.rollbacks" />
        </>
      }
      confirmLabel="Rollback"
      successMessage="Rollback started"
      onConfirm={rollback}
    />
  );
}

// RollbackButton - the standalone Rollback button, beside Redeploy.
export function RollbackButton({
  id,
  appSlug,
  commitSha,
  commitMessage,
  can,
  size = "sm",
}: {
  id: string;
  appSlug: string;
  commitSha?: string;
  commitMessage?: string;
  can: boolean;
  size?: "sm" | "default";
}) {
  const [open, setOpen] = React.useState(false);

  // Cosmetic only - the data layer is the real gate; disabled says why on hover.
  if (!can) {
    return (
      <CapabilityTip cap="rollback_apps">
        <Button variant="outline" size={size} disabled>
          <Undo2 className="size-4" />
          Rollback
        </Button>
      </CapabilityTip>
    );
  }

  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        <Undo2 className="size-4" />
        Rollback
      </Button>
      <RollbackDialog
        open={open}
        onOpenChange={setOpen}
        id={id}
        appSlug={appSlug}
        commitSha={commitSha}
        commitMessage={commitMessage}
      />
    </>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CapabilityTip } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Rollback - putting an app back on a build it already ran.
 *
 * The dialog lives here rather than beside each trigger because the copy is the
 * load-bearing part: everyone assumes a rollback restores the settings that went
 * with the code, and it does not. Two triggers use it (the deployments row menu
 * and a deployment's own page) and they must not drift into telling two stories.
 */
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
  /** The deployment being returned TO. */
  id: string;
  /** Owning app slug - used to follow the new build to its live logs. */
  appSlug: string;
  commitSha?: string;
  commitMessage?: string;
}) {
  const router = useRouter();

  // Returns the ActionResult so ConfirmAction owns the toast + close. On success
  // we follow the new build the way Redeploy does: it is a real deployment with
  // real logs, just a very short one.
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
    // No typed confirmation on purpose: this goes back to a build that already
    // ran on this server, and it is itself undone by rolling forward again.
    // Ceremony everywhere is ceremony nowhere.
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title="Roll back to this deployment?"
      description={
        <span className="flex flex-col gap-2">
          <span>
            The app goes back to the image this deployment built
            {commitSha ? (
              <>
                {" ("}
                <span className="font-mono">{commitSha.slice(0, 7)}</span>
                {commitMessage ? ` ${commitMessage}` : ""}
                {")"}
              </>
            ) : null}
            . It restarts in seconds - nothing is rebuilt.
          </span>
          <span className="text-muted-foreground">
            Only the code goes back. Variables, domains, storage and resource
            limits stay as they are now.
          </span>
        </span>
      }
      confirmLabel="Rollback"
      successMessage="Rollback started"
      onConfirm={rollback}
    />
  );
}

/** The standalone Rollback button - a deployment's own page, beside Redeploy. */
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
  /** Whether the viewer holds `rollback_apps`. Cosmetic - the data layer decides. */
  can: boolean;
  size?: "sm" | "default";
}) {
  const [open, setOpen] = React.useState(false);

  // Without the permission the button is plainly disabled and says why on hover,
  // rather than failing on click - the server would refuse it anyway.
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

"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { SimpleTooltip } from "@/components/ui/tooltip";
import Link from "@/components/ui/link";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";

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

  if (!can) {
    return (
      <CapabilityTip cap="rollback_apps">
        <Button variant="outline" size={size} disabled>
          <RotateCcw className="size-4" />
          Rollback
        </Button>
      </CapabilityTip>
    );
  }

  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        <RotateCcw className="size-4" />
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

export function AppRollbackButton({
  slug,
  target,
}: {
  slug: string;
  target: { id: string; commitSha: string; commitMessage: string } | null;
}) {
  const canRollback = useAppCan("rollback_apps");
  const canBackups = useAppCan("manage_backups");

  if (target)
    return (
      <RollbackButton
        id={target.id}
        appSlug={slug}
        commitSha={target.commitSha}
        commitMessage={target.commitMessage}
        can={canRollback}
      />
    );

  // Nothing left to go back to: a backup is the only way back.
  const label = (
    <>
      <RotateCcw className="size-4" />
      Rollback
    </>
  );
  if (!canBackups)
    return (
      <SimpleTooltip content="No earlier build is kept on the server to go back to">
        <span className="inline-flex cursor-not-allowed">
          <Button variant="outline" size="sm" disabled>
            {label}
          </Button>
        </span>
      </SimpleTooltip>
    );
  return (
    <SimpleTooltip content="No earlier build to go back to - restore this app from a backup instead">
      <Button variant="outline" size="sm" asChild>
        <Link href={`/apps/${slug}/backups`}>{label}</Link>
      </Button>
    </SimpleTooltip>
  );
}

"use client";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import { joinNames } from "@/lib/utils";

// A connected app reaches its database only from its own environment, so a move waits for this.
export function DisconnectAppsDialog({
  open,
  onOpenChange,
  databaseId,
  databaseName,
  apps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  databaseId: string;
  databaseName: string;
  apps: string[];
}) {
  const router = useRouter();
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title="Disconnect apps first"
      description={
        <>
          <strong>{databaseName}</strong> is connected to {joinNames(apps)}. Its
          environment can change once no app is connected.{" "}
          <DocsLink topic="databases.connect" />
        </>
      }
      consequence={
        apps.length === 1
          ? `That app stops following ${databaseName}. Its variables keep today's value, which stops working once it moves.`
          : `Those apps stop following ${databaseName}. Their variables keep today's value, which stops working once it moves.`
      }
      confirmLabel="Disconnect all apps"
      successMessage="Apps disconnected. You can change the environment now."
      onConfirm={async () => {
        const res = await gqlAction(
          /* GraphQL */ `
            mutation ($databaseId: String!) {
              disconnectDatabaseFromAllApps(databaseId: $databaseId)
            }
          `,
          { databaseId },
        );
        if (res.ok) router.refresh();
        return res;
      }}
    />
  );
}

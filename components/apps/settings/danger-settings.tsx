"use client";

import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import {
  Card,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Danger zone: permanently delete this app and everything it owns. A
 * self-describing red card within the Advanced settings section. On success the
 * browser returns to the dashboard (the app no longer exists).
 */
export function DangerSettings({
  appId,
  name,
}: {
  appId: string;
  name: string;
}) {
  const router = useRouter();
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base text-destructive">
          Danger Zone
          <InfoTip content="Permanently delete this app and all of its data." />
        </CardTitle>
      </CardHeader>
      <CardFooter className="justify-end">
        <DeleteWithArtifacts
          trigger={
            <Button variant="destructive" size="sm">
              <Trash2 className="size-4" />
              Delete App
            </Button>
          }
          targetKind="service"
          targetId={appId}
          targetName={name}
          title={`Delete ${name}?`}
          description="This permanently removes the app, deployments, domains and environment variables. This cannot be undone."
          confirmLabel="Delete app"
          successMessage="App deleted"
          deleteMutation={() =>
            gqlAction(`mutation($id: String!) { deleteApp(id: $id) }`, {
              id: appId,
            })
          }
          onDeleted={() => router.push("/")}
        />
      </CardFooter>
    </Card>
  );
}

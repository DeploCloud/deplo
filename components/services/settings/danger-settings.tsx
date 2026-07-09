"use client";

import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Danger zone: permanently delete this service and everything it owns. Its own
 * self-describing red card, on its own settings page. On success the browser
 * returns to the dashboard (the service no longer exists).
 */
export function DangerSettings({
  serviceId,
  name,
}: {
  serviceId: string;
  name: string;
}) {
  const router = useRouter();
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
        <CardDescription>
          Permanently delete this service and all of its data.
        </CardDescription>
      </CardHeader>
      <CardFooter className="justify-end">
        <DeleteWithArtifacts
          trigger={
            <Button variant="destructive" size="sm">
              <Trash2 className="size-4" />
              Delete Service
            </Button>
          }
          targetKind="service"
          targetId={serviceId}
          targetName={name}
          title={`Delete ${name}?`}
          description="This permanently removes the service, deployments, domains and environment variables. This cannot be undone."
          confirmLabel="Delete service"
          successMessage="Service deleted"
          deleteMutation={() =>
            gqlAction(`mutation($id: String!) { deleteService(id: $id) }`, {
              id: serviceId,
            })
          }
          onDeleted={() => router.push("/")}
        />
      </CardFooter>
    </Card>
  );
}

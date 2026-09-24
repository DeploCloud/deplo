"use client";

import * as React from "react";
import { toast } from "sonner";
import { FlaskConical } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";

export function CanaryReleasesCard({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    onChange(next);
    startTransition(async () => {
      const res = await gqlAction(
        /* GraphQL */ `
          mutation SetCanaryReleases($enabled: Boolean!) {
            setCanaryReleases(enabled: $enabled) {
              canary
            }
          }
        `,
        { enabled: next },
      );
      if (res.ok) {
        toast.success(
          next ? "Canary releases turned on" : "Back to stable releases",
        );
      } else {
        onChange(!next);
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4 text-muted-foreground" />
          Canary releases
        </CardTitle>
        <CardDescription>
          {enabled
            ? "Every new version shows up as an update."
            : "Only stable versions show up as updates."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <FieldLabel
            htmlFor="canary-releases"
            info="New versions before they are marked stable. They can have bugs, and nothing installs until you click Update."
          >
            Offer canary versions
          </FieldLabel>
          <Switch
            id="canary-releases"
            checked={enabled}
            disabled={pending}
            onCheckedChange={toggle}
          />
        </div>
      </CardContent>
    </Card>
  );
}

"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";

export function NewReposSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = React.useState(enabled);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($enabled: Boolean!) { setSuggestNewRepos(enabled: $enabled) }`,
        { enabled: next },
      );
      if (!res.ok) {
        setOn(!next);
        toast.error(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="flex items-start justify-between gap-4 p-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          Suggest new repositories
          <Badge variant="muted">Only for you</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          Show repositories created in the last 7 days on the Overview, ready to
          deploy.
        </p>
      </div>
      <Switch
        checked={on}
        onCheckedChange={toggle}
        disabled={pending}
        aria-label="Suggest new repositories"
      />
    </Card>
  );
}

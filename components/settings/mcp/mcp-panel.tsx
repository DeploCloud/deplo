"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The team's one MCP switch.
 *
 * One, on purpose. It ships ON and it is a policy lever for a company that
 * wants AI access off — not what makes the endpoint safe, since a token is
 * required either way and revoking it is still how access is taken away. What
 * an agent may DO is the token's Capabilities and nothing else: a second set of
 * switches here would be a second permission system, and it could only ever
 * drift from the first.
 */
export function McpPanel({
  enabled: initialEnabled,
  canManage,
}: {
  enabled: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initialEnabled);

  function toggle(next: boolean) {
    setEnabled(next);
    startTransition(async () => {
      const res = await gqlAction<{ setMcpSettings: unknown }, unknown>(
        /* GraphQL */ `
          mutation SetMcpSettings($enabled: Boolean!) {
            setMcpSettings(enabled: $enabled) {
              enabled
            }
          }
        `,
        { enabled: next },
        (d) => d.setMcpSettings,
      );
      if (res.ok) {
        toast.success(
          next
            ? "AI agents can now drive this team"
            : "MCP access is off for this team",
        );
        router.refresh();
      } else {
        setEnabled(!next);
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Access
          <InfoTip content="Applies to every API token that reaches this team, whoever minted it." />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Allow AI agents</p>
            <p className="text-xs text-muted-foreground">
              Off means the MCP endpoint refuses every request for this team,
              whatever the token can do.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            disabled={!canManage || pending}
            aria-label="Allow AI agents"
          />
        </div>
      </CardContent>
    </Card>
  );
}

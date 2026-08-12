"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The team's two MCP switches.
 *
 * Both ship ON. "Enabled" is a policy lever for a company that wants AI access
 * off, not what makes the endpoint safe — a token is required either way, and
 * revoking it is still the way access is taken away. "Ask before destructive
 * actions" is the one that earns its place on first run: the first time an
 * agent decides to delete something should be a question in the operator's
 * client, not a fact discovered afterwards.
 */
export function McpPanel({
  enabled: initialEnabled,
  confirmDestructive: initialConfirm,
  canManage,
}: {
  enabled: boolean;
  confirmDestructive: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [confirm, setConfirm] = React.useState(initialConfirm);

  function save(
    patch: { enabled?: boolean; confirmDestructive?: boolean },
    revert: () => void,
    message: string,
  ) {
    startTransition(async () => {
      const res = await gqlAction<{ setMcpSettings: unknown }, unknown>(
        /* GraphQL */ `
          mutation SetMcpSettings($enabled: Boolean, $confirmDestructive: Boolean) {
            setMcpSettings(enabled: $enabled, confirmDestructive: $confirmDestructive) {
              enabled
              confirmDestructive
            }
          }
        `,
        patch,
        (d) => d.setMcpSettings,
      );
      if (res.ok) {
        toast.success(message);
        router.refresh();
      } else {
        revert();
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
      <CardContent className="space-y-3">
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
            onCheckedChange={(next) => {
              setEnabled(next);
              save(
                { enabled: next },
                () => setEnabled(!next),
                next
                  ? "AI agents can now drive this team"
                  : "MCP access is off for this team",
              );
            }}
            disabled={!canManage || pending}
            aria-label="Allow AI agents"
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Ask before destructive actions
            </p>
            <p className="text-xs text-muted-foreground">
              Deleting, rebuilding or restoring waits for you to confirm in your
              AI client before it runs.
            </p>
          </div>
          <Switch
            checked={confirm}
            onCheckedChange={(next) => {
              setConfirm(next);
              save(
                { confirmDestructive: next },
                () => setConfirm(!next),
                next
                  ? "Agents will ask before destructive actions"
                  : "Agents will act without asking",
              );
            }}
            disabled={!canManage || pending || !enabled}
            aria-label="Ask before destructive actions"
          />
        </div>
      </CardContent>
    </Card>
  );
}

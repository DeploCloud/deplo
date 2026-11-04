"use client";

import Link from "@/components/ui/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { Bone } from "@/components/ui/skeleton";
import { AgentsGraphic } from "@/components/settings/agents-graphic";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { gqlAction } from "@/lib/graphql-client";

export function TeamAgentsCard({
  enabled,
  canManage,
  agents,
  loading = false,
}: {
  enabled: boolean;
  canManage: boolean;
  agents: number;
  loading?: boolean;
}) {
  const [on, apply] = useOptimisticValue(enabled);

  function toggle(next: boolean) {
    apply(
      next,
      () =>
        gqlAction<{ setMcpSettings: unknown }, unknown>(
          /* GraphQL */ `
            mutation SetMcpSettings($enabled: Boolean!) {
              setMcpSettings(enabled: $enabled) {
                enabled
              }
            }
          `,
          { enabled: next },
          (d) => d.setMcpSettings,
        ),
      {
        success: next
          ? "AI agents are on for this team"
          : "AI agents are off for this team",
      },
    );
  }

  return (
    <Card className="flex flex-col md:col-span-2 xl:col-span-1">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          AI agents
          <InfoTip
            content="Off, no member can reach this team from an agent, and the agents already connected stop working here."
            docs="mcp.overview"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex min-h-0 flex-1 items-center justify-center py-2">
          <AgentsGraphic className="max-h-20" />
        </div>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Allow AI agents</p>
            <p className="text-xs text-muted-foreground">
              Members can connect their own AI agents here.
            </p>
            <p className="pt-1 text-xs text-muted-foreground">
              <Bone loading={loading}>
                {agents === 0
                  ? "No agents yet."
                  : `${agents} agent${agents === 1 ? "" : "s"} connected.`}
              </Bone>{" "}
              <Link
                href="/settings/agents"
                className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
              >
                Connect yours
              </Link>
            </p>
          </div>
          <Bone box loading={loading} className="rounded-full">
            <Switch
              checked={on}
              onCheckedChange={toggle}
              disabled={!canManage}
              aria-label="Allow AI agents"
            />
          </Bone>
        </div>
      </CardContent>
    </Card>
  );
}

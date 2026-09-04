"use client";

import * as React from "react";
import { EllipsisVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { gqlAction } from "@/lib/graphql-client";
import { RobotMark } from "./robot-graphic";
import { cn } from "@/lib/utils";

/**
 * Beside the illustration: how many agents can act in this team, and - for
 * whoever manages the team - its one MCP switch. What an agent may DO is its
 * token's Capabilities and its owner's permissions, never a switch here.
 */
export function McpSwitchMenu({
  count,
  enabled: initialEnabled,
  canManage,
  className,
}: {
  count: number;
  enabled: boolean;
  canManage: boolean;
  className?: string;
}) {
  const [enabled, applyEnabled] = useOptimisticValue(initialEnabled);

  function toggle(next: boolean) {
    applyEnabled(
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
          ? "MCP Server is on for this team"
          : "MCP Server is off for this team",
      },
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1 text-sm text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <RobotMark />
        {count} {count === 1 ? "agent" : "agents"} connected
      </span>
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="MCP Server settings"
            >
              <EllipsisVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              // Stays open: a switch is flipped, not picked.
              onSelect={(e) => {
                e.preventDefault();
                toggle(!enabled);
              }}
              className="gap-3"
            >
              <span className="flex-1">Enable MCP Server</span>
              <Switch
                checked={enabled}
                aria-label="Enable MCP Server"
                tabIndex={-1}
                className="pointer-events-none"
              />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

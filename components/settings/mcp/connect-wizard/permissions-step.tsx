"use client";

import * as React from "react";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/info-tip";
import type { ScopeSelection } from "@/components/settings/tokens/scope-picker/selection";
import { scopeLabel } from "@/components/settings/tokens/scope-label";
import { presetIdFor, TOKEN_PRESETS } from "@/lib/token-presets";
import type { Capability } from "@/lib/types/identity";
import type { ScopeTreeTeam } from "@/lib/data/tokens/scope-tree";
import type { AgentDef } from "../agents";
import { ToolsDialog, type McpToolSummary } from "../tools-dialog";
import { StepShell } from "./step-shell";

// PermissionsStep names the token and summarises what it may do, then mints it.
export function PermissionsStep({
  agent,
  tools,
  tree,
  name,
  caps,
  scope,
  expiry,
  pending,
  canConnect,
  onName,
  onExpiry,
  onEdit,
  onCreate,
}: {
  agent: AgentDef;
  tools: McpToolSummary[];
  tree: ScopeTreeTeam[];
  name: string;
  caps: Capability[];
  scope: ScopeSelection;
  expiry: string;
  pending: boolean;
  canConnect: boolean;
  onName: (value: string) => void;
  onExpiry: (value: string) => void;
  onEdit: (which: "permissions" | "access") => void;
  onCreate: () => void;
}) {
  return (
    <StepShell
      title={`What may ${agent.label} do?`}
      lead="Deplo mints an API token here. You can change or revoke it later without touching the agent."
      action={
        <>
          <ToolsDialog
            tools={tools}
            highlight={caps}
            trigger={
              <Button variant="outline" className="mr-auto">
                See tools
              </Button>
            }
          />
          <Button
            onClick={onCreate}
            disabled={pending || !name.trim() || !canConnect}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            Create token
          </Button>
        </>
      }
    >
      <div className="w-full space-y-4 text-left">
        <div className="grid gap-2">
          <FieldLabel
            htmlFor="mcp-token-name"
            info="How this connection is listed in Settings → API tokens, where you can change or revoke it."
            docs="mcp.connect"
          >
            Name
          </FieldLabel>
          <Input
            id="mcp-token-name"
            value={name}
            onChange={(e) => onName(e.target.value)}
            maxLength={40}
          />
        </div>

        <div className="divide-y divide-border rounded-lg border border-border">
          <SummaryRow label="Permissions" onClick={() => onEdit("permissions")}>
            <span className="truncate text-sm">
              {presetIdFor(caps)
                ? TOKEN_PRESETS.find((p) => p.id === presetIdFor(caps))!.name
                : `${caps.length} selected`}
            </span>
          </SummaryRow>
          <SummaryRow label="Access" onClick={() => onEdit("access")}>
            <span className="truncate text-sm">
              {
                scopeLabel(
                  {
                    scoped:
                      scope.teamIds.length +
                        scope.projectIds.length +
                        scope.folderIds.length +
                        scope.appIds.length >
                      0,
                    ...scope,
                  },
                  Object.fromEntries(tree.map((t) => [t.id, t.name])),
                ).text
              }
            </span>
          </SummaryRow>
          <div className="flex items-center gap-3 p-3">
            <span className="shrink-0 text-sm text-muted-foreground">
              Expires
            </span>
            <div className="ml-auto">
              <Select value={expiry} onValueChange={onExpiry}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">In 30 days</SelectItem>
                  <SelectItem value="90">In 90 days</SelectItem>
                  <SelectItem value="365">In a year</SelectItem>
                  <SelectItem value="never">Never</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
    </StepShell>
  );
}

function SummaryRow({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Change ${label.toLowerCase()}`}
      className="flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-accent"
    >
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {children}
      </span>
      <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/info-tip";
import { DocsLink } from "@/components/ui/docs-link";
import { PermissionPicker } from "@/components/settings/permission-picker";
import { ScopePicker } from "@/components/settings/tokens/scope-picker/picker";
import type { ScopeSelection } from "@/components/settings/tokens/scope-picker/selection";
import { presetIdFor, TOKEN_PRESETS } from "@/lib/token-presets";
import type { Capability } from "@/lib/types/identity";
import type { ScopeTreeTeam } from "@/lib/data/tokens/scope-tree";
import type { AgentDef } from "../agents";

const CUSTOM = "custom";

export function PermissionsDialog({
  open,
  onOpenChange,
  agent,
  caps,
  onCaps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentDef | null;
  caps: Capability[];
  onCaps: (caps: Capability[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What {agent?.label ?? "this agent"} may do</DialogTitle>
          <DialogDescription className="mt-1">
            Start from a template, then tick exactly what it needs.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            onOpenChange(false);
          }}
        >
          <div className="grid gap-3">
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="mcp-preset"
                info="A starting set you can then adjust. Custom appears once the ticks stop matching one."
                docs="tokens.capabilities"
              >
                Template
              </FieldLabel>
              <Select
                value={presetIdFor(caps) ?? CUSTOM}
                onValueChange={(id) => {
                  const next = TOKEN_PRESETS.find((p) => p.id === id);
                  if (next) onCaps(next.capabilities);
                }}
              >
                <SelectTrigger id="mcp-preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOKEN_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  {presetIdFor(caps) ? null : (
                    <SelectItem value={CUSTOM} disabled>
                      Custom
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <PermissionPicker
              capabilities={caps}
              onChange={onCaps}
              scroll
              hint="Tick exactly what this agent should be able to do. A secret can never be read over MCP, whatever is ticked here."
            />
          </div>
          <DialogFooter>
            <Button type="submit">Done</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AccessDialog({
  open,
  onOpenChange,
  agent,
  tree,
  scope,
  onScope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentDef | null;
  tree: ScopeTreeTeam[];
  scope: ScopeSelection;
  onScope: (scope: ScopeSelection) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            What {agent?.label ?? "this agent"} can reach
          </DialogTitle>
          <DialogDescription className="mt-1">
            <strong>Nothing ticked means every team</strong> you can connect
            agents to. Tick one to limit it. <DocsLink topic="tokens.scope" />
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            onOpenChange(false);
          }}
        >
          <ScopePicker
            tree={tree}
            selection={scope}
            onChange={onScope}
            info="Where this agent may work. Nothing ticked is every team you can connect agents to; a tick limits it to that."
            docs="tokens.scope"
          />
          <DialogFooter>
            <Button type="submit">Done</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

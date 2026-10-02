"use client";

import { cn } from "@/lib/utils";
import { veilProps } from "@/components/templates/veil";
import { AGENTS, type AgentDef, type AgentId } from "../agents";
import { StepShell } from "./step-shell";

const GROUPS = [
  { kind: "web", label: "Sign in with your account" },
  { kind: "token", label: "Connect with a token" },
] as const;

export function AgentStep({
  agentId,
  canConnect,
  onPick,
}: {
  agentId: AgentId | null;
  canConnect: boolean;
  onPick: (id: AgentId) => void;
}) {
  return (
    <StepShell
      title="Which agent are you connecting?"
      lead={
        canConnect
          ? "Each one wants its configuration in a different place, so Deplo writes the right one for you."
          : "Needs the permission to connect AI agents to this team."
      }
    >
      <div role="radiogroup" aria-label="Agent" className="w-full space-y-5">
        {GROUPS.map((g) => (
          <div key={g.kind}>
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {g.label}
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {AGENTS.filter((a) => a.kind === g.kind).map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  selected={agentId === a.id}
                  disabled={!canConnect}
                  onSelect={() => onPick(a.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </StepShell>
  );
}

export function AgentMark({
  agent,
  size = "sm",
}: {
  agent: AgentDef;
  size?: "sm" | "lg";
}) {
  const Icon = agent.icon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md ring-1 ring-border",
        size === "lg" ? "size-10" : "size-8",
        !agent.brand && "bg-surface-strong text-muted-foreground",
      )}
      style={
        agent.brand
          ? { backgroundColor: agent.brand.bg, color: agent.brand.fg }
          : undefined
      }
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}

export function AgentCard({
  agent,
  selected,
  disabled,
  onSelect,
}: {
  agent: AgentDef;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const veil = veilProps(agent.veil, selected ? "on" : "hover");

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      style={veil.style}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20",
        veil.className,
      )}
    >
      <AgentMark agent={agent} />
      <span className="min-w-0 text-sm leading-snug font-medium">
        {agent.label}
      </span>
    </button>
  );
}

"use client";

import { cn } from "@/lib/utils";
import { veilProps } from "@/components/templates/veil";
import { AGENTS, type AgentDef, type AgentId } from "../agents";
import { StepShell } from "./step-shell";

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
      lead="Each one wants its configuration in a different place, so Deplo writes the right one for you."
    >
      <div
        role="radiogroup"
        aria-label="Agent"
        className="grid w-full gap-2 sm:grid-cols-2"
      >
        {AGENTS.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            selected={agentId === a.id}
            canConnect={canConnect}
            onSelect={() => onPick(a.id)}
          />
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
  canConnect,
  onSelect,
}: {
  agent: AgentDef;
  selected: boolean;
  canConnect: boolean;
  onSelect: () => void;
}) {
  const blocked = !canConnect;
  const note = "Needs the permission to connect AI agents to this team.";
  const veil = veilProps(agent.veil, selected ? "on" : "hover");

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={blocked}
      onClick={onSelect}
      style={veil.style}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20",
        veil.className,
      )}
    >
      <AgentMark agent={agent} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{agent.label}</span>
        <span className="mt-0.5 line-clamp-2 min-h-[2lh] text-xs leading-snug text-muted-foreground">
          {blocked ? note : agent.blurb}
        </span>
      </span>
    </button>
  );
}

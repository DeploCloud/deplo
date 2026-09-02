"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ExternalLink,
  Loader2,
  Pencil,
  Plug,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { CodeBlock, CommandLine } from "@/components/shared/code-block";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { PermissionPicker } from "@/components/settings/permission-picker";
import {
  ScopePicker,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { scopeLabel } from "@/components/settings/tokens/scope-label";
import { gqlAction } from "@/lib/graphql-client";
import { presetIdFor, TOKEN_PRESETS } from "@/lib/token-presets";
import { cn } from "@/lib/utils";
import type { Capability } from "@/lib/types";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import {
  AGENTS,
  TOKEN_PLACEHOLDER,
  type AgentDef,
  type AgentId,
} from "./agents";
import { RobotGraphic, type RobotState } from "./robot-graphic";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { ToolsDialog, type McpToolSummary } from "./tools-dialog";
import { veilProps } from "@/components/templates/veil";

/**
 * Connecting an AI agent, as one path that never leaves the page. Getting
 * connected meant reading the snippet, leaving, filling in a token editor, copying
 * a secret, coming back, and reassembling the snippet by hand around it.
 */

type StepId = "enable" | "agent" | "permissions" | "connect" | "done";

const STEP_LABEL: Record<StepId, string> = {
  enable: "Turn on",
  agent: "Agent",
  permissions: "Permissions",
  connect: "Connect",
  done: "Done",
};

/** Radix needs a value for "matches no preset"; it is never chosen. */
const CUSTOM = "custom";

/** The template a first-time connection starts from. */
const MCP_PRESET = TOKEN_PRESETS.find((p) => p.id === "mcp")!;

/** How long the wizard listens before it offers a manual retry. */
const POLL_MS = 2000;
const POLL_LIMIT = 150;

export function ConnectWizard({
  mcpEnabled,
  canManageMcp,
  canManageTokens,
  publicUrl,
  tree,
  activeTeamId,
  tools,
  connectionCount,
  onGoToManage,
}: {
  mcpEnabled: boolean;
  canManageMcp: boolean;
  canManageTokens: boolean;
  publicUrl: string;
  tree: ScopeTreeTeam[];
  activeTeamId: string;
  tools: McpToolSummary[];
  /** Connections already in this team, from the server. Drives the return view. */
  connectionCount: number;
  onGoToManage: () => void;
}) {
  const router = useRouter();
  const host = publicUrl.replace(/\/+$/, "") || "https://your-deplo-host";
  const url = `${host}/api/mcp`;
  const https = url.startsWith("https://");
  const [runId, setRunId] = React.useState(0);

  // The tab always opens on the wizard, whether or not agents are already connected.
  return (
    <WizardRun
      // Remounting is the reset: starting over must not inherit the last run's
      // token, agent or confetti.
      key={runId}
      mcpEnabled={mcpEnabled}
      canManageMcp={canManageMcp}
      canManageTokens={canManageTokens}
      url={url}
      https={https}
      tree={tree}
      activeTeamId={activeTeamId}
      tools={tools}
      connectionCount={connectionCount}
      onGoToManage={onGoToManage}
      onRestart={() => setRunId((n) => n + 1)}
      onRefresh={() => router.refresh()}
    />
  );
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

function WizardRun({
  mcpEnabled,
  canManageMcp,
  canManageTokens,
  url,
  https,
  tree,
  activeTeamId,
  tools,
  connectionCount,
  onGoToManage,
  onRestart,
  onRefresh,
}: {
  mcpEnabled: boolean;
  canManageMcp: boolean;
  canManageTokens: boolean;
  url: string;
  https: boolean;
  tree: ScopeTreeTeam[];
  activeTeamId: string;
  tools: McpToolSummary[];
  connectionCount: number;
  onGoToManage: () => void;
  onRestart: () => void;
  onRefresh: () => void;
}) {
  const [enabled, setEnabled] = React.useState(mcpEnabled);
  const [step, setStep] = React.useState<StepId>(
    mcpEnabled ? "agent" : "enable",
  );
  const [agentId, setAgentId] = React.useState<AgentId | null>(null);
  const [pending, setPending] = React.useState(false);

  // The token being minted. `name` is prefilled from the agent so the common
  // case is zero typing, and stays editable because two Cursors on one team are
  // otherwise indistinguishable in the list.
  const [name, setName] = React.useState("");
  const [caps, setCaps] = React.useState<Capability[]>(MCP_PRESET.capabilities);
  const [expiry, setExpiry] = React.useState("90");
  const [scope, setScope] = React.useState<ScopeSelection>({
    // Scoped to THIS team from the start.
    teamIds: [activeTeamId],
    projectIds: [],
    folderIds: [],
    appIds: [],
  });
  const [editing, setEditing] = React.useState<null | "permissions" | "access">(
    null,
  );

  const [secret, setSecret] = React.useState<string | null>(null);
  const [tokenId, setTokenId] = React.useState<string | null>(null);
  // Lifted out of the last step, because the illustration that reacts to it
  // lives in the other column and the listening now starts a step earlier.
  const [connected, setConnected] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [round, setRound] = React.useState(0);
  // Frozen on mount: the web branch reads success as "one more connection than
  // there was", so a baseline moved by any refresh would mean nothing.
  const [baseline] = React.useState(connectionCount);

  const agent = agentId ? AGENTS.find((a) => a.id === agentId)! : null;
  const web = agent?.kind === "web";
  const minted = secret !== null;

  // Listening starts with the snippet on screen: pasting it IS the action, so a
  // button to confirm it afterwards only delays the tick that follows.
  React.useEffect(() => {
    if (!agent || connected || attempt >= POLL_LIMIT) return;
    if (step !== "connect" && step !== "done") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const hit = await probe(agent.kind, tokenId, baseline);
      if (cancelled) return;
      if (!hit) {
        setAttempt((n) => n + 1);
        return;
      }
      setConnected(true);
      setStep("done");
      // The Manage tab reads from the server, so it has to be told.
      onRefresh();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agent, tokenId, baseline, connected, attempt, round, step, onRefresh]);

  const gaveUp = !connected && attempt >= POLL_LIMIT;
  function checkAgain() {
    setAttempt(0);
    setRound((n) => n + 1);
  }

  const steps: StepId[] = [
    ...(mcpEnabled ? [] : (["enable"] as StepId[])),
    "agent",
    ...(agent && !web ? (["permissions"] as StepId[]) : []),
    "connect",
    "done",
  ];
  const valid: Record<StepId, boolean> = {
    enable: enabled,
    agent: agent !== null,
    permissions: name.trim().length > 0,
    connect: web || minted,
    done: false,
  };
  function pick(id: AgentId) {
    const next = AGENTS.find((a) => a.id === id)!;
    setAgentId(id);
    // Only overwrite a name the reader has not touched - retyping their label
    // because they went back one step would be the wizard arguing with them.
    setName((current) =>
      current === "" || AGENTS.some((a) => a.label === current)
        ? next.label
        : current,
    );
    // And straight on: picking the agent IS this step's answer, so a Continue button
    // beside it would ask the same question twice.
    setStep(next.kind === "web" ? "connect" : "permissions");
  }

  async function turnOn() {
    setPending(true);
    const res = await gqlAction(
      /* GraphQL */ `
        mutation TurnOnMcp {
          setMcpSettings(enabled: true) {
            enabled
          }
        }
      `,
      {},
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setEnabled(true);
    setStep("agent");
    onRefresh();
  }

  async function createToken() {
    setPending(true);
    const res = await gqlAction<
      { createToken: { raw: string; token: { id: string } } },
      { raw: string; id: string }
    >(
      /* GraphQL */ `
        mutation CreateMcpToken($input: CreateTokenInput!) {
          createToken(input: $input) {
            raw
            token {
              id
            }
          }
        }
      `,
      {
        input: {
          name: name.trim(),
          capabilities: caps,
          teamIds: scope.teamIds,
          projectIds: scope.projectIds,
          folderIds: scope.folderIds,
          appIds: scope.appIds,
          // `never` is an explicit null; anything else is that many days from
          // now, the same arithmetic the token editor does.
          expiresAt:
            expiry === "never"
              ? null
              : new Date(
                  Date.now() + Number(expiry) * 86_400_000,
                ).toISOString(),
        },
      },
      (d) => ({ raw: d.createToken.raw, id: d.createToken.token.id }),
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (!res.data) return;
    setSecret(res.data.raw);
    setTokenId(res.data.id);
    setStep("connect");
    onRefresh();
  }

  const robot: RobotState = connected
    ? "connected"
    : step === "done" || step === "connect"
      ? "reaching"
      : step === "permissions"
        ? "key"
        : "idle";

  return (
    // Two columns only from `xl`, not `lg`. The content column can never be squeezed by
    // it - the picture only takes what the window itself grew by.
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_clamp(24rem,30vw,36rem)] xl:gap-12">
      {/* First in the DOM on a phone, where the picture on top reads as a
          heading; last on a wide screen, where it belongs on the right. */}
      <div className="relative order-first flex justify-center xl:sticky xl:top-24 xl:order-last xl:self-start">
        {/* Drawn in the chosen agent's own colour - the same hue its card wears
            when selected, so the picture and the tick agree. */}
        <RobotGraphic
          state={robot}
          accent={agent?.veil}
          className="h-auto w-52 xl:w-[92%]"
        />
        {/* Mounted only on success, so it plays once and replays whenever a new
            run reaches the end. */}
        {connected && <ConfettiBurst className="top-28" />}
      </div>

      {/**
       * One measure for every step, and a NARROW one: the column is a rail, a two-card
       * grid, a short form and a code block in turn, and letting it take the whole 1fr
       * track made each of those grow with the window until the agent cards were 374px of
       */}
      <div className="max-w-xl min-w-0 space-y-6">
        <WizardStepper
          steps={steps.map((id) => ({ id, label: STEP_LABEL[id] }))}
          current={step}
          // Once the secret exists there is nothing left to edit: revisiting the
          // permissions step could only mint a second token for the same agent.
          // "Done" is the agent's to reach, never a click's.
          reachable={(s) =>
            s === "done"
              ? connected
              : minted
                ? s === "connect"
                : steps.slice(0, steps.indexOf(s)).every((p) => valid[p])
          }
          onSelect={setStep}
        />

        <div>
          {step === "enable" && (
            <StepShell
              title="The MCP Server is off for this team"
              lead="Turning it on lets an agent act here with an API token you control. What it may actually do is that token's permissions, and nothing else."
            >
              {canManageMcp ? (
                <Button onClick={turnOn} disabled={pending}>
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Turn on MCP for this team
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A team admin has to switch it on before an agent can connect.
                </p>
              )}
            </StepShell>
          )}

          {step === "agent" && (
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
                    canManageMcp={canManageMcp}
                    canManageTokens={canManageTokens}
                    onSelect={() => pick(a.id)}
                  />
                ))}
              </div>
            </StepShell>
          )}

          {step === "permissions" && agent && (
            <StepShell
              title={`What may ${agent.label} do?`}
              lead="Deplo mints an API token here. You can change or revoke it later without touching the agent."
            >
              <div className="w-full space-y-4 text-left">
                <div className="grid gap-2">
                  <FieldLabel
                    htmlFor="mcp-token-name"
                    info="How this connection is listed under Manage, and in Settings → API tokens."
                    docs="mcp.connect"
                  >
                    Name
                  </FieldLabel>
                  <Input
                    id="mcp-token-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                  />
                </div>

                <div className="divide-y divide-border rounded-lg border border-border">
                  <SummaryRow
                    label="Permissions"
                    onClick={() => setEditing("permissions")}
                  >
                    <span className="truncate text-sm">
                      {presetIdFor(caps)
                        ? TOKEN_PRESETS.find((p) => p.id === presetIdFor(caps))!
                            .name
                        : `${caps.length} selected`}
                    </span>
                  </SummaryRow>
                  <SummaryRow
                    label="Access"
                    onClick={() => setEditing("access")}
                  >
                    <span className="truncate text-sm">
                      {
                        scopeLabel(
                          { scoped: true, ...scope },
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
                      <Select value={expiry} onValueChange={setExpiry}>
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

                <ToolsDialog
                  tools={tools}
                  highlight={caps}
                  trigger={
                    <button
                      type="button"
                      className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      This opens {reachedTools(tools, caps)} of {tools.length}{" "}
                      tools. See which
                    </button>
                  }
                />
              </div>

              <Button
                onClick={createToken}
                disabled={pending || !name.trim() || !canManageTokens}
              >
                {pending && <Loader2 className="size-4 animate-spin" />}
                Create token
              </Button>
            </StepShell>
          )}

          {step === "connect" && agent && (
            <StepShell
              // For a web client the heading is the ACTION and the lead is the path through its
              // menus.
              mark={<AgentMark agent={agent} size="lg" />}
              title={
                web
                  ? `Add Deplo as a connector in ${agent.label}`
                  : "Add this to your agent"
              }
              lead={
                web
                  ? agent.hint
                  : "The token is already in it. This is the only time Deplo can show that secret."
              }
            >
              <div className="w-full space-y-3 text-left">
                {agent.form === "command" ? (
                  <CommandLine
                    command={agent.snippet({
                      url,
                      token: secret ?? TOKEN_PLACEHOLDER,
                    })}
                  />
                ) : (
                  <CodeBlock
                    code={agent.snippet({
                      url,
                      token: secret ?? TOKEN_PLACEHOLDER,
                    })}
                    filename={agent.file}
                    language={agent.language}
                  />
                )}
                {/* The path already ran as the lead for a web client; what is
                    left to say there is what happens after the paste. */}
                <p className="text-xs text-muted-foreground">
                  {web
                    ? "Deplo then asks you to sign in and choose what it may do. Nothing is shared until you approve it."
                    : agent.hint}
                </p>

                {web && !https && (
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
                    <span>
                      {agent.label} can only reach an address served over https.
                      Set one under Settings → General.
                    </span>
                  </p>
                )}
                {/* Only for a FILE. A shell command is typed once and is not
                    committed to anything, so warning about it there is advice
                    about a situation the reader is not in. */}
                {!web && agent.form === "file" && (
                  <p className="text-xs text-muted-foreground">
                    Committing this file? Put the token in an environment
                    variable and reference it instead.
                  </p>
                )}

                <a
                  href={agent.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  {agent.label} documentation
                  <ExternalLink className="size-3" />
                </a>
              </div>

              {gaveUp ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Deplo has not heard from {agent.label} yet. Start it, or ask
                    it to list its tools.
                  </p>
                  <Button variant="outline" onClick={checkAgain}>
                    Check again
                  </Button>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Waiting for {agent.label} to call Deplo
                </p>
              )}
            </StepShell>
          )}

          {step === "done" && agent && (
            <DoneStep
              agent={agent}
              onGoToManage={onGoToManage}
              onRestart={onRestart}
            />
          )}
        </div>
      </div>

      {/* The token is on screen and shown once, and leaving also stops the
          listening - so the way out asks first. */}
      <UnsavedChangesGuard
        when={minted && !connected}
        title="Leave before the agent connects?"
        description="Deplo shows this token once. If you leave now you'll have to create a new one for this agent."
        confirmLabel="Leave anyway"
        cancelLabel="Stay on this page"
      />

      {/* Advanced, on demand: two dialogs rather than one, because narrowing
          the reach and choosing what may be done there are two decisions, and
          the row you pressed said which one you came for. */}
      <Dialog
        open={editing === "permissions"}
        onOpenChange={(open) => setEditing(open ? "permissions" : null)}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              What {agent?.label ?? "this agent"} may do
            </DialogTitle>
            <DialogDescription className="mt-1">
              Start from a template, then tick exactly what it needs.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(null);
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
                    if (next) setCaps(next.capabilities);
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
                onChange={setCaps}
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

      <Dialog
        open={editing === "access"}
        onOpenChange={(open) => setEditing(open ? "access" : null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              What {agent?.label ?? "this agent"} can reach
            </DialogTitle>
            <DialogDescription className="mt-1">
              This team is ticked. Narrow it to a project, a folder or single
              apps if the agent only works on one corner.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(null);
            }}
          >
            <ScopePicker
              tree={tree}
              selection={scope}
              onChange={setScope}
              info="Where this agent may work. Tick a team for all of it, or narrow it to a project, folder or single apps."
              docs="tokens.scope"
            />
            <DialogFooter>
              <Button type="submit">Done</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Every step is the same shape: a question, one line under it, the controls, then
 * one primary button.
 */
function StepShell({
  mark,
  title,
  lead,
  children,
}: {
  mark?: React.ReactNode;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-5">
      <div>
        {mark ? <span className="mb-3 flex">{mark}</span> : null}
        <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{lead}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * An agent's logo on its own tile, in the agent's own colours.
 */
function AgentMark({
  agent,
  size = "sm",
}: {
  agent: AgentDef;
  /** `lg` above a heading, `sm` inside a card. */
  size?: "sm" | "lg";
}) {
  const Icon = agent.icon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md ring-1 ring-border",
        size === "lg" ? "size-10" : "size-8",
        !agent.brand && "bg-muted/50 text-muted-foreground",
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

function AgentCard({
  agent,
  selected,
  canManageMcp,
  canManageTokens,
  onSelect,
}: {
  agent: AgentDef;
  selected: boolean;
  canManageMcp: boolean;
  canManageTokens: boolean;
  onSelect: () => void;
}) {
  // Shown but refused, with the reason - the two branches need different
  // capabilities, and hiding half the grid would leave a reader wondering
  // whether Deplo supports their agent at all.
  const blocked = agent.kind === "web" ? !canManageMcp : !canManageTokens;
  const note =
    agent.kind === "web"
      ? "Needs the permission to manage MCP access."
      : "Needs the permission to create API tokens.";
  // The same wash the template store's cards wear, in the brand's own colour: lit on
  // hover while you are still looking, and held lit once this is the one you chose.
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
        // The ring still carries "chosen": the wash says which brand, not which
        // state, and on a card with no brand there would be nothing to say it.
        selected
          ? "border-primary ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20",
        veil.className,
      )}
    >
      <AgentMark agent={agent} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{agent.label}</span>
        {/**
         * Exactly two lines, reserved AND capped. No `block` here: `line-clamp-2` sets
         * `display: -webkit-box`, and a `block` beside it wins the cascade and silently
         * turns the clamp off, which is how a four-line ChatGPT card got through.
         */}
        <span className="mt-0.5 line-clamp-2 min-h-[2lh] text-xs leading-snug text-muted-foreground">
          {blocked ? note : agent.blurb}
        </span>
      </span>
    </button>
  );
}

/**
 * The last step, reached only by a real request from the agent.
 */
function DoneStep({
  agent,
  onGoToManage,
  onRestart,
}: {
  agent: AgentDef;
  onGoToManage: () => void;
  onRestart: () => void;
}) {
  return (
    <StepShell
      mark={<AgentMark agent={agent} size="lg" />}
      title="Connected successfully!"
      lead="It made its first call to Deplo. You can revoke its access at any time under Manage."
    >
      {/* Two ways on, because there are two things people do next: look at what
          they just let in, or let in the next one. Neither leaves this page. */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onGoToManage}>
          <Check className="size-4" />
          Done
        </Button>
        <Button variant="outline" onClick={onRestart}>
          <Plug className="size-4" />
          Connect another
        </Button>
      </div>
    </StepShell>
  );
}

/** One poll. Silent on failure: a hiccup is a reason to try again, not to shout. */
async function probe(
  kind: AgentDef["kind"],
  tokenId: string | null,
  baseline: number,
): Promise<boolean> {
  if (kind === "token") {
    if (!tokenId) return false;
    const res = await gqlAction<{ mcpConnected: boolean }, boolean>(
      /* GraphQL */ `
        query McpConnected($tokenId: String!) {
          mcpConnected(tokenId: $tokenId)
        }
      `,
      { tokenId },
      (d) => d.mcpConnected,
    );
    return res.ok && res.data === true;
  }
  const res = await gqlAction<{ mcpConnections: { id: string }[] }, number>(
    /* GraphQL */ `
      query McpConnectionCount {
        mcpConnections {
          id
        }
      }
    `,
    {},
    (d) => d.mcpConnections.length,
  );
  return res.ok && typeof res.data === "number" && res.data > baseline;
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */

/** One line of the summary - a label, what it says now, and a way in. */
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

/** How many tools a capability set actually opens. `null` requires nothing. */
function reachedTools(tools: McpToolSummary[], caps: string[]): number {
  const held = new Set(caps);
  return tools.filter(
    (t) =>
      t.requires === null ||
      (t.requires !== "instanceAdmin" && held.has(t.requires)),
  ).length;
}

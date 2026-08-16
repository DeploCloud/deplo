"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowRight,
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
import { AGENTS, TOKEN_PLACEHOLDER, type AgentDef, type AgentId } from "./agents";
import { ConfettiBurst, RobotGraphic, type RobotState } from "./robot-graphic";
import { ToolsDialog, type McpToolSummary } from "./tools-dialog";

/**
 * Connecting an AI agent, as one path that never leaves the page.
 *
 * What it replaces: a snippet card with `deplo_your_token` written into it, and
 * a link out to Settings → API tokens. Getting connected meant reading the
 * snippet, leaving, filling in a token editor, copying a secret, coming back,
 * and reassembling the snippet by hand around it. Every one of those steps is a
 * place to lose the thread, and the last one is a place to get it subtly wrong.
 *
 * So the token is minted HERE, at the step where the question "what may this
 * agent do" is actually being asked, and the step after it prints the finished
 * configuration with the real secret already in place. Copy, paste, done — which
 * is the whole promise of the MCP server and was the one thing this page did not
 * deliver.
 *
 * Four decisions, in the order they have to be made:
 *
 *  0. `enable`      — only when the team's switch is off. A new team's is
 *                     (migration 0106), so without this step the happy path
 *                     ended in a 403 nobody could have predicted from here.
 *  1. `agent`       — which client, because their config files genuinely differ.
 *  2. `permissions` — token clients only; a web client is granted on deplo's own
 *                     consent screen, and asking twice would be asking twice.
 *  3. `connect`     — the finished configuration.
 *  4. `done`        — waits for the agent's FIRST REAL CALL and then celebrates.
 *                     "You copied something" and "your agent is talking to
 *                     deplo" are different claims and only the second is worth
 *                     making.
 *
 * The wizard renders inline rather than in a dialog, unlike the other four in
 * this repo: those are actions launched from a list, and this one IS the tab.
 * Its two Advanced editors are dialogs, though, exactly as the consent screen
 * does it — the summary row you pressed says which question you came to answer.
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

/** How long the last step keeps asking before it offers a manual retry. */
const POLL_MS = 2000;
const POLL_LIMIT = 90;

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

  // Someone coming back to a team that already has agents wants the address, not
  // four steps. The wizard is one button away and starts from scratch when
  // pressed; a returning reader is not made to walk a path they finished.
  const [running, setRunning] = React.useState(connectionCount === 0);
  const [runId, setRunId] = React.useState(0);

  if (!running)
    return (
      <ConnectedSummary
        url={url}
        count={connectionCount}
        onStart={() => {
          setRunId((n) => n + 1);
          setRunning(true);
        }}
      />
    );

  return (
    <WizardRun
      // Remounting is the reset: "Connect another" must not inherit the last
      // run's token, agent or confetti.
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
    // Scoped to THIS team from the start. It bounds the credential to the team
    // the person is looking at (naming teams restricts nothing inside them, so
    // no capability is lost), and it is also what makes every snippet shorter:
    // one reachable team means `identityForTokenRow` needs no `X-Deplo-Team`
    // header to land in the right place.
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
  // Lifted out of the last step, because the illustration that reacts to it now
  // lives in the other column. `DoneStep` still owns the polling.
  const [connected, setConnected] = React.useState(false);

  const agent = agentId ? AGENTS.find((a) => a.id === agentId)! : null;
  const web = agent?.kind === "web";
  const minted = secret !== null;

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
  const index = Math.max(0, steps.indexOf(step));

  function pick(id: AgentId) {
    const next = AGENTS.find((a) => a.id === id)!;
    setAgentId(id);
    // Only overwrite a name the reader has not touched — retyping their label
    // because they went back one step would be the wizard arguing with them.
    setName((current) =>
      current === "" || AGENTS.some((a) => a.label === current)
        ? next.label
        : current,
    );
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
    // Everything you act on down the left, the illustration large on the right.
    // The rail travels with the content, so "where am I" and "what do I do" are
    // one glance rather than two, and the drawing is the one element that never
    // changes place — it anchors the page while the column beside it swaps
    // between a switch, a grid, a form and a snippet.
    //
    // Borderless on purpose: this IS the tab, and a card drawn around the whole
    // of a tab is a box around a box.
    <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-12">
      {/* First in the DOM on a phone, where the picture on top reads as a
          heading; last on a wide screen, where it belongs on the right. */}
      <div className="relative order-first flex justify-center lg:order-last lg:sticky lg:top-24 lg:self-start">
        <RobotGraphic state={robot} className="h-auto w-52 lg:w-full" />
        {/* Mounted only on success, so it plays once and replays whenever a new
            run reaches the end. */}
        {connected && <ConfettiBurst className="top-28" />}
      </div>

      <div className="min-w-0 space-y-6">
        <WizardStepper
          steps={steps.map((id) => ({ id, label: STEP_LABEL[id] }))}
          current={step}
          // Once the secret exists there is nothing left to edit: revisiting the
          // permissions step could only mint a second token for the same agent.
          reachable={(s) =>
            minted
              ? s === "connect" || s === "done"
              : steps.slice(0, steps.indexOf(s)).every((p) => valid[p])
          }
          onSelect={setStep}
        />

        <div>
          {step === "enable" && (
            <StepShell
              title="AI agents are switched off for this team"
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
              lead="Each one wants its configuration in a different place, so deplo writes the right one for you."
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
              <Button
                onClick={() => setStep(steps[index + 1])}
                disabled={!agent}
              >
                Continue
                <ArrowRight className="size-4" />
              </Button>
            </StepShell>
          )}

          {step === "permissions" && agent && (
            <StepShell
              title={`What may ${agent.label} do?`}
              lead="deplo mints an API token for it, here. You can change or revoke it later without touching the agent."
            >
              <div className="w-full space-y-4 text-left">
                <div className="grid gap-2">
                  <FieldLabel
                    htmlFor="mcp-token-name"
                    info="How this connection is listed under Manage, and in Settings → API tokens."
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
                  <SummaryRow label="Access" onClick={() => setEditing("access")}>
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
              title={web ? `Paste this into ${agent.label}` : "Add this to your agent"}
              lead={
                web
                  ? "You will be asked to sign in to deplo and approve what the app may do. Nothing is shared until you approve it."
                  : "The token is already in it. This is the only time deplo can show that secret."
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
                <p className="text-xs text-muted-foreground">{agent.hint}</p>

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

              <Button onClick={() => setStep("done")}>
                I have added it
                <ArrowRight className="size-4" />
              </Button>
            </StepShell>
          )}

          {step === "done" && agent && (
            <DoneStep
              agent={agent}
              tokenId={tokenId}
              baselineConnections={connectionCount}
              connected={connected}
              onConnected={() => {
                setConnected(true);
                // The Manage tab reads from the server, so it has to be told.
                onRefresh();
              }}
              onGoToManage={onGoToManage}
            />
          )}
        </div>
      </div>

      {/* Advanced, on demand: two dialogs rather than one, because narrowing
          the reach and choosing what may be done there are two decisions, and
          the row you pressed said which one you came for. */}
      <Dialog
        open={editing === "permissions"}
        onOpenChange={(open) => setEditing(open ? "permissions" : null)}
      >
        <DialogContent className="sm:max-w-3xl">
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
              setEditing(null);
            }}
          >
            <div className="grid gap-3">
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="mcp-preset"
                  info="A starting set you can then adjust. Custom appears once the ticks stop matching one."
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
 * Every step is the same shape: a question, one line under it, the controls,
 * then one primary button. Holding that shape is what makes the four steps feel
 * like one flow rather than four screens someone bolted together.
 *
 * Left-aligned, because the illustration is on the left: a centred column of
 * text beside a picture has no edge for the eye to come back to, and every line
 * starts somewhere different.
 */
function StepShell({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-5">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{lead}</p>
      </div>
      {children}
    </div>
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
  // Shown but refused, with the reason — the two branches need different
  // capabilities, and hiding half the grid would leave a reader wondering
  // whether deplo supports their agent at all.
  const blocked =
    agent.kind === "web" ? !canManageMcp : !canManageTokens;
  const note =
    agent.kind === "web"
      ? "Needs the permission to manage MCP access."
      : "Needs the permission to create API tokens.";
  const Icon = agent.icon;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={blocked}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20 hover:bg-muted/40",
      )}
    >
      {/* The agent's own colours, always — not only when selected. The tile is
          what you scan for, and a grid that only colours the card you already
          picked has helped you exactly once you no longer need it. The ring is
          a token, so a near-black brand still has an edge on a dark background;
          the fill and the glyph are the brand's and stay put in both themes. */}
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md ring-1 ring-border",
          !agent.brand && "bg-muted/50 text-muted-foreground",
        )}
        style={
          agent.brand
            ? { backgroundColor: agent.brand.bg, color: agent.brand.fg }
            : undefined
        }
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{agent.label}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {blocked ? note : agent.blurb}
        </span>
      </span>
    </button>
  );
}

/**
 * The last step: wait for a real request, then celebrate it.
 *
 * A token client is asked about by id — the wizard just minted it and knows
 * which one to watch. A web client cannot be: the person is now inside
 * claude.ai approving a consent screen, the token is minted by that flow, and
 * the only thing this side can watch is the team's connection count going up.
 *
 * It gives up after three minutes rather than polling a forgotten tab forever,
 * and says so with a button instead of going quiet.
 */
function DoneStep({
  agent,
  tokenId,
  baselineConnections,
  connected,
  onConnected,
  onGoToManage,
}: {
  agent: AgentDef;
  tokenId: string | null;
  baselineConnections: number;
  /** Owned by the run, because the illustration in the other column reads it. */
  connected: boolean;
  onConnected: () => void;
  onGoToManage: () => void;
}) {
  const [round, setRound] = React.useState(0);
  const [attempt, setAttempt] = React.useState(0);
  // Frozen on mount, via the lazy initialiser. The web branch detects success
  // as "one more connection than there was", so a baseline that moved under it
  // — any `router.refresh` elsewhere on the page — would make the comparison
  // meaningless.
  const [baseline] = React.useState(baselineConnections);

  React.useEffect(() => {
    if (connected || attempt >= POLL_LIMIT) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const hit = await probe(agent.kind, tokenId, baseline);
      if (cancelled) return;
      if (hit) onConnected();
      else setAttempt((n) => n + 1);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agent.kind, tokenId, baseline, connected, attempt, round, onConnected]);

  const gaveUp = !connected && attempt >= POLL_LIMIT;

  return (
    <StepShell
      title={
        connected ? `${agent.label} is connected` : `Waiting for ${agent.label}`
      }
      lead={
        connected
          ? "It made its first call to deplo. You can revoke its access at any time under Manage."
          : gaveUp
            ? "deplo has not heard from it yet. Start the agent, or ask it to list its tools, then check again."
            : "This lights up the moment the agent actually calls deplo, not when the configuration is saved."
      }
    >
      {connected ? (
        <Button onClick={onGoToManage}>
          <Check className="size-4" />
          Done
        </Button>
      ) : gaveUp ? (
        <Button
          variant="outline"
          onClick={() => {
            setAttempt(0);
            setRound((n) => n + 1);
          }}
        >
          Check again
        </Button>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Listening
        </p>
      )}
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
/* The return view                                                     */
/* ------------------------------------------------------------------ */

function ConnectedSummary({
  url,
  count,
  onStart,
}: {
  url: string;
  count: number;
  onStart: () => void;
}) {
  return (
    // One centred column, unlike a wizard step: nothing here is being filled in,
    // so there is no form to keep a left edge for. It is a status — how many
    // agents, the address, and a way to add one more — and a status reads best
    // stacked under its own picture.
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
      <RobotGraphic state="connected" className="h-auto w-56 sm:w-64" />
      <div>
        <h2 className="text-base font-semibold">
          {count} {count === 1 ? "agent is" : "agents are"} connected to this
          team
        </h2>
        <p className="mt-1 text-sm text-balance text-muted-foreground">
          This is the address they all use. Take an agent&apos;s access away
          under Manage.
        </p>
      </div>
      {/* The block stays left-aligned inside: a URL centred in a code box reads
          as decoration rather than as something to copy. */}
      <div className="w-full text-left">
        <CodeBlock code={url} />
      </div>
      <Button onClick={onStart}>
        <Plug className="size-4" />
        Connect another
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */

/** One line of the summary — a label, what it says now, and a way in. */
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
      <span className="ml-auto flex min-w-0 items-center gap-2">{children}</span>
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

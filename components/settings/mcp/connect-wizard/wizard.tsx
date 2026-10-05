"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import type { ScopeSelection } from "@/components/settings/tokens/scope-picker/selection";
import { gqlAction } from "@/lib/graphql-client";
import { TOKEN_PRESETS } from "@/lib/token-presets";
import type { Capability } from "@/lib/types/identity";
import type { ScopeTreeTeam } from "@/lib/data/tokens/scope-tree";
import { AGENTS, type AgentId } from "../agents";
import { RobotGraphic, type RobotState } from "../robot-graphic";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { POLL_LIMIT, POLL_MS, probe } from "./connection-probe";
import { AgentStep } from "./agent-picker";
import { ConnectStep } from "./connect-step";
import { DoneStep } from "./done-step";
import { EnableStep } from "./enable-step";
import { PermissionsStep } from "./permissions-step";
import { AccessDialog, PermissionsDialog } from "./token-dialogs";

type StepId = "enable" | "agent" | "permissions" | "connect" | "done";

const STEP_LABEL: Record<StepId, string> = {
  enable: "Turn on",
  agent: "Agent",
  permissions: "Permissions",
  connect: "Connect",
  done: "Done",
};

const MCP_PRESET = TOKEN_PRESETS.find((p) => p.id === "mcp")!;

export function ConnectWizard({
  mcpEnabled,
  canConnect,
  canManageTeam,
  publicUrl,
  tree,
  connectionCount,
}: {
  mcpEnabled: boolean;
  canConnect: boolean;
  canManageTeam: boolean;
  publicUrl: string;
  tree: ScopeTreeTeam[];
  connectionCount: number;
}) {
  const router = useRouter();
  const host = publicUrl.replace(/\/+$/, "") || "https://your-deplo-host";
  const url = `${host}/api/mcp`;
  const https = url.startsWith("https://");
  const [runId, setRunId] = React.useState(0);

  return (
    <WizardRun
      key={runId}
      mcpEnabled={mcpEnabled}
      canConnect={canConnect}
      canManageTeam={canManageTeam}
      url={url}
      https={https}
      tree={tree}
      connectionCount={connectionCount}
      onRestart={() => setRunId((n) => n + 1)}
      onRefresh={() => router.refresh()}
    />
  );
}

function WizardRun({
  mcpEnabled,
  canConnect,
  canManageTeam,
  url,
  https,
  tree,
  connectionCount,
  onRestart,
  onRefresh,
}: {
  mcpEnabled: boolean;
  canConnect: boolean;
  canManageTeam: boolean;
  url: string;
  https: boolean;
  tree: ScopeTreeTeam[];
  connectionCount: number;
  onRestart: () => void;
  onRefresh: () => void;
}) {
  const [enabled, setEnabled] = React.useState(mcpEnabled);
  const [step, setStep] = React.useState<StepId>(
    mcpEnabled ? "agent" : "enable",
  );
  const [agentId, setAgentId] = React.useState<AgentId | null>(null);
  const [pending, setPending] = React.useState(false);

  const [name, setName] = React.useState("");
  const [caps, setCaps] = React.useState<Capability[]>(MCP_PRESET.capabilities);
  const [expiry, setExpiry] = React.useState("90");
  const [scope, setScope] = React.useState<ScopeSelection>({
    teamIds: [],
    projectIds: [],
    folderIds: [],
    appIds: [],
  });
  const [editing, setEditing] = React.useState<null | "permissions" | "access">(
    null,
  );

  const [secret, setSecret] = React.useState<string | null>(null);
  const [tokenId, setTokenId] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [round, setRound] = React.useState(0);
  const [baseline] = React.useState(connectionCount);

  const agent = agentId ? AGENTS.find((a) => a.id === agentId)! : null;
  const web = agent?.kind === "web";
  const minted = secret !== null;

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
      onRefresh();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agent, tokenId, baseline, connected, attempt, round, step, onRefresh]);

  const gaveUp = !connected && attempt >= POLL_LIMIT;
  const [discarding, setDiscarding] = React.useState(false);
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
    // Done only once the token exists: Connect has nothing to show before it.
    permissions: minted,
    connect: web || minted,
    done: false,
  };
  function back() {
    if (step === "connect" && minted) setDiscarding(true);
    else setStep(steps[steps.indexOf(step) - 1]);
  }

  // Going back past a minted token deletes it, so no unused credential is left behind.
  async function discardToken() {
    const res = await gqlAction(
      /* GraphQL */ `
        mutation DiscardMcpToken($id: String!) {
          revokeToken(id: $id)
        }
      `,
      { id: tokenId },
    );
    if (res.ok) {
      setSecret(null);
      setTokenId(null);
      setAttempt(0);
      setStep("permissions");
      onRefresh();
    }
    return res;
  }

  function pick(id: AgentId) {
    const next = AGENTS.find((a) => a.id === id)!;
    setAgentId(id);
    setName((current) =>
      current === "" || AGENTS.some((a) => a.label === current)
        ? next.label
        : current,
    );
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
          mcpAgent: agentId,
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

  if (step === "done" && agent)
    return (
      <DoneStep agent={agent} connected={connected} onRestart={onRestart} />
    );

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_clamp(24rem,30vw,36rem)] xl:gap-12">
      <div className="relative order-first flex justify-center pt-2 xl:sticky xl:top-24 xl:order-last xl:self-start xl:pt-16">
        <RobotGraphic
          state={robot}
          accent={agent?.veil}
          className="h-auto w-52 xl:w-[92%]"
        />
        {connected && <ConfettiBurst className="top-28" />}
      </div>

      <div className="max-w-xl min-w-0 space-y-6">
        <WizardStepper
          steps={steps.map((id) => ({ id, label: STEP_LABEL[id] }))}
          current={step}
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
            <EnableStep
              canManageTeam={canManageTeam}
              pending={pending}
              onTurnOn={turnOn}
            />
          )}

          {step === "agent" && (
            <AgentStep
              agentId={agentId}
              canConnect={canConnect}
              onPick={pick}
            />
          )}

          {step === "permissions" && agent && (
            <PermissionsStep
              agent={agent}
              tree={tree}
              name={name}
              caps={caps}
              scope={scope}
              expiry={expiry}
              pending={pending}
              canConnect={canConnect}
              onName={setName}
              onExpiry={setExpiry}
              onEdit={setEditing}
              onCreate={createToken}
              onBack={back}
            />
          )}

          {step === "connect" && agent && (
            <ConnectStep
              agent={agent}
              web={web}
              https={https}
              url={url}
              secret={secret}
              gaveUp={gaveUp}
              onCheckAgain={checkAgain}
              onDone={() => setStep("done")}
              onBack={back}
            />
          )}
        </div>
      </div>

      <ConfirmAction
        open={discarding}
        onOpenChange={setDiscarding}
        title="Go back and delete this token?"
        description={
          <>
            The token is shown only once, so going back{" "}
            <strong>deletes it</strong>.
          </>
        }
        consequence="An agent you already gave it to stops working. Create token makes a new one."
        confirmLabel="Delete and go back"
        successMessage="Token deleted"
        onConfirm={discardToken}
      />

      <UnsavedChangesGuard
        when={minted && !connected}
        title="Leave before the agent connects?"
        description="Deplo shows this token once. If you leave now you'll have to create a new one for this agent."
        confirmLabel="Leave anyway"
        cancelLabel="Stay on this page"
      />

      <PermissionsDialog
        open={editing === "permissions"}
        onOpenChange={(open) => setEditing(open ? "permissions" : null)}
        agent={agent}
        caps={caps}
        onCaps={setCaps}
      />

      <AccessDialog
        open={editing === "access"}
        onOpenChange={(open) => setEditing(open ? "access" : null)}
        agent={agent}
        tree={tree}
        scope={scope}
        onScope={setScope}
      />
    </div>
  );
}

"use client";

import {
  Check,
  Loader2,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { CommandLine } from "@/components/shared/code-block";
import { Button } from "@/components/ui/button";
import { AGENT_PORT_NOTICE } from "@/lib/agent-reachability";
import type { PlanServer } from "../types";
import { AddressForm } from "./address-form";
import {
  AGENT_UNREACHABLE,
  CLOUDFLARE_ADDRESS_NOTICE,
  PANEL_ADDRESS_NOTICE,
} from "./machine-state";
import type { MachineInstall } from "./use-machine-install";

// MachineRow is one machine of the source: its verdict, its line to run, its address.
export function MachineRow({
  m,
  canAddServers,
  install,
}: {
  m: PlanServer;
  canAddServers: boolean;
  install: MachineInstall;
}) {
  const {
    adoptable,
    draft,
    setDraft,
    editing,
    setEditing,
    saveAddress,
    checkAgain,
    adopt,
    registerManually,
  } = install;
  const p = install.pending[m.sourceId];
  const error = install.failed[m.sourceId];
  const bad = install.unreachable[m.sourceId];
  const working = install.busy[m.sourceId] === true;
  return (
    <div className="space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{m.name}</span>
          {(p?.address || m.ipAddress) && (
            <span className="truncate text-xs text-muted-foreground">
              {p?.address || m.ipAddress}
            </span>
          )}
        </div>
        {m.deploServerOnline ? (
          <span className="flex shrink-0 items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-success">
              <Check className="size-3.5" />
              Connected
            </span>
            {canAddServers && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                onClick={() =>
                  setEditing((prev) => ({
                    ...prev,
                    [m.sourceId]: !prev[m.sourceId],
                  }))
                }
              >
                Change address
              </button>
            )}
          </span>
        ) : adoptable[m.sourceId] ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            Already reachable
          </span>
        ) : error ? (
          <span className="flex min-w-0 items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">{error}</span>
          </span>
        ) : bad ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-destructive">
            <TriangleAlert className="size-3.5" />
            {bad.status === "offline"
              ? "Cannot connect"
              : "Cannot use this machine"}
          </span>
        ) : p ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for the agent
          </span>
        ) : canAddServers ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Registering
          </span>
        ) : (
          <span className="shrink-0 text-xs text-warning">
            Ask an instance admin to add this machine
          </span>
        )}
      </div>

      {p && !bad && <CommandLine command={p.installCommand} truncate />}

      {p && bad && bad.status !== "offline" && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">{bad.message}</p>
          <CommandLine command={p.installCommand} truncate />
          <Button
            type="button"
            variant="outline"
            disabled={working}
            onClick={() => void checkAgain(m.sourceId, p)}
          >
            {working ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Check again"
            )}
          </Button>
        </div>
      )}

      {p && bad && bad.status === "offline" && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">
            {AGENT_UNREACHABLE}{" "}
            {m.cloudflare
              ? CLOUDFLARE_ADDRESS_NOTICE
              : `${AGENT_PORT_NOTICE} ${PANEL_ADDRESS_NOTICE}`}
          </p>
          <p className="text-xs text-muted-foreground">{bad.message}</p>
          <CommandLine command={p.installCommand} truncate />
          {canAddServers ? (
            <AddressForm
              value={draft[m.sourceId] ?? ""}
              onChange={(v) =>
                setDraft((prev) => ({ ...prev, [m.sourceId]: v }))
              }
              onSubmit={() => void saveAddress(m.sourceId, p)}
              submitLabel="Save"
              onSecondary={() => void checkAgain(m.sourceId, p)}
              secondaryLabel="Check again"
              working={working}
            />
          ) : (
            <p className="text-xs text-warning">
              Ask an instance admin to change its address.
            </p>
          )}
        </div>
      )}

      {m.deploServerOnline && editing[m.sourceId] && m.deploServerId && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            A machine that answers can still be the wrong one. Every volume of
            the services on it would arrive empty.
          </p>
          <AddressForm
            value={draft[m.sourceId] ?? ""}
            onChange={(v) => setDraft((prev) => ({ ...prev, [m.sourceId]: v }))}
            onSubmit={() =>
              void saveAddress(m.sourceId, {
                serverId: m.deploServerId!,
                name: m.deploServerName ?? m.name,
                installCommand: "",
                address: m.ipAddress ?? "",
              })
            }
            submitLabel="Save"
            working={working}
          />
        </div>
      )}

      {!p && !m.deploServerOnline && adoptable[m.sourceId] && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Deplo already reaches this machine as {adoptable[m.sourceId].name}.
            Nothing to install.
          </p>
          <Button
            type="button"
            disabled={working}
            onClick={() => void adopt(m, adoptable[m.sourceId])}
          >
            {working ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              `Use ${adoptable[m.sourceId].name}`
            )}
          </Button>
        </div>
      )}

      {!p && !m.deploServerOnline && !adoptable[m.sourceId] && error && (
        <div className="space-y-2">
          {canAddServers ? (
            <AddressForm
              value={draft[m.sourceId] ?? ""}
              onChange={(v) =>
                setDraft((prev) => ({ ...prev, [m.sourceId]: v }))
              }
              onSubmit={() => void registerManually(m)}
              submitLabel="Register"
              working={working}
            />
          ) : (
            <p className="text-xs text-warning">
              Ask an instance admin to add it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

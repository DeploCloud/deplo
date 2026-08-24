"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Check,
  Loader2,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { CommandLine } from "@/components/shared/code-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StepShell } from "./step-shell";
import { AGENT_PORT_NOTICE } from "@/components/shared/agent-reachability";
import type { PlanServer } from "./types";

/**
 * Getting Deplo's agent onto the machines behind that Dokploy.
 *
 * This is a GATE, not a summary. Deplo copies a volume by asking the agent ON
 * the host that holds it - there is no other way in, and agents cannot dial each
 * other - so a Dokploy machine with no agent is a machine whose databases arrive
 * empty and stay empty. Finding that out at the end, with the old platform
 * already stopped, is the failure this screen exists to prevent. There is no
 * "skip this one".
 *
 * For a long time the gate did not gate. It waited for the server to leave
 * `provisioning`, which happens on the CALL-HOME - a request the agent makes
 * OUTBOUND, over 443, from behind whatever firewall the host has. That proves
 * the agent is alive; it proves nothing about the direction a copy needs, which
 * is the control plane dialing the agent's own port. Two very ordinary setups
 * satisfy the old check and then lose every byte:
 *
 *  - the address is the other platform's PANEL hostname, and the panel sits
 *    behind Cloudflare or another reverse proxy, so it resolves to the proxy;
 *  - the host has a firewall (any stock cloud image) and the agent port was
 *    never opened.
 *
 * So the step now PROBES - `checkServerHealth`, the same live Hello the Servers
 * page runs - and a machine counts as connected only when that comes back
 * `online`. The verdict costs about eight seconds, and when it is bad the row
 * offers the two things that fix it: the address, and a re-check for after the
 * firewall was changed.
 *
 * Registering the server is NOT a button. Somebody who has just handed Deplo a
 * working API key has already said yes to the only question ("may Deplo have
 * these machines"); an "Add it as a server" per row was a second yes for the
 * same decision, and every one of them had to be clicked before the command it
 * produced could even be read. So the step registers them on arrival and gets
 * straight to the only thing a person can actually do here: run one line on
 * each box.
 *
 * The command is truncated on purpose. It is 200 characters of bootstrap token,
 * nobody reads it, and Copy takes the whole thing.
 *
 * The step ends itself. Every machine reporting in is not a decision, so it does
 * not get a Continue - it waits, then moves on. That includes the common case
 * where every machine was already ours, which shows for a beat so the reader
 * sees that it was checked rather than skipped.
 */

const ADD_SERVER = /* GraphQL */ `
  mutation AddServerForMigration($input: AddServerInput!) {
    addServer(input: $input) {
      server {
        id
        name
      }
      installCommand
    }
  }
`;

/**
 * A live probe, not a read of the stored row - the whole point of the gate. It
 * also covers the provisioning phase for free: an agent that has not called home
 * yet has no certificate, and `checkServerHealth` passes an unprovisioned server
 * straight through untouched.
 */
const CHECK_HEALTH = /* GraphQL */ `
  mutation CheckMigrationServerHealth($id: String!) {
    checkServerHealth(id: $id, force: true) {
      id
      status
      statusMessage
    }
  }
`;

/**
 * `keepHost` is what keeps a corrected machine recognisable: the row was
 * registered at the panel's address, and that is the address a second pass of
 * the wizard matches the Dokploy machine by. See the flag's own doc in
 * `lib/data/servers.ts`.
 */
const CHANGE_ADDRESS = /* GraphQL */ `
  mutation ChangeMigrationServerAddress($id: String!, $address: String!) {
    updateServerAddress(id: $id, address: $address, keepHost: true)
  }
`;

/** How long the finished step sits there before it moves on by itself. */
const SETTLE_MS = 2000;
/**
 * How often a machine short of its agent is asked again. Above the 5s floor the
 * forced health check keeps even when asked explicitly - a tick landing exactly
 * on it would be answered from the previous observation.
 */
const POLL_MS = 6000;

/** What the probe said, for a machine that answered badly or not at all. */
interface Unreachable {
  /** `offline` (nothing answered) or `error` (answered, but not as itself). */
  status: string;
  /** The server's own sentence, shown verbatim. */
  message: string;
}

/**
 * A machine Deplo has registered and is now waiting to hear from.
 *
 * Owned by the WIZARD, not by this step. The step unmounts the moment somebody
 * clicks another chip on the rail, and a registration that died with it came
 * back as "X is already registered at that address" the second time - the one
 * error `addServer` raises for a migration source - with the install command
 * they had not run yet gone from the screen.
 */
export interface PendingMachine {
  serverId: string;
  name: string;
  installCommand: string;
}

export function InstallStep({
  machines,
  canAddServers,
  pending,
  setPending,
  attempted,
  onResolved,
  onDone,
}: {
  machines: PlanServer[];
  /** Registering a host is instance-admin only, like everywhere else. */
  canAddServers: boolean;
  /** Registered, waiting to be heard from. The wizard holds it - see above. */
  pending: Record<string, PendingMachine>;
  setPending: React.Dispatch<
    React.SetStateAction<Record<string, PendingMachine>>
  >;
  /**
   * Which machines have been through `addServer` already, so revisiting this
   * step never registers one twice. A ref rather than state because it must not
   * cause a render, and the wizard's rather than this component's because it has
   * to outlive the step. A FAILED attempt takes itself back out, since no row
   * was created and trying again is the right thing to do.
   */
  attempted: React.RefObject<Set<string>>;
  /** One machine just came online: it now maps to this Deplo server. */
  onResolved: (sourceId: string, serverId: string, serverName: string) => void;
  /** Every machine is ours. Carry on to the review. */
  onDone: () => void;
}) {
  const [failed, setFailed] = React.useState<Record<string, string>>({});
  const [unreachable, setUnreachable] = React.useState<
    Record<string, Unreachable>
  >({});
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});

  const missing = machines.filter((m) => !m.deploServerId);
  const settled = missing.length === 0;

  // ---- register whatever is not ours yet, once, on arrival ----------
  React.useEffect(() => {
    if (!canAddServers) return;
    let cancelled = false;
    (async () => {
      for (const m of machines) {
        // Checked BEFORE the machine is marked attempted: a resolved machine
        // rewrites `machines`, which re-runs this effect and cancels the old
        // one, and a machine claimed by a run that then stops would never be
        // registered by anybody.
        if (cancelled) return;
        if (m.deploServerId || attempted.current.has(m.sourceId)) continue;
        attempted.current.add(m.sourceId);
        if (!m.ipAddress) {
          setFailed((p) => ({
            ...p,
            [m.sourceId]: "Deplo could not work out that machine's address.",
          }));
          continue;
        }
        // One at a time rather than all at once: a failure has to be able to
        // name the machine it happened on, and two hosts registering in
        // parallel produce two toasts nobody can tell apart.
        const res = await gqlAction<
          {
            addServer: {
              server: { id: string; name: string };
              installCommand: string;
            };
          },
          { server: { id: string; name: string }; installCommand: string }
        >(
          ADD_SERVER,
          {
            input: {
              name: m.sourceId ? m.name : "dokploy-host",
              host: m.ipAddress,
              // A MIGRATION SOURCE, not a server: the install command touches
              // nothing on the box but the agent itself, the host stays out of
              // every picker and every sweep, and finishing the migration
              // uninstalls it again.
              importOnly: true,
            },
          },
          (d) => d.addServer,
        );
        // Deliberately NOT bailing on `cancelled` here: the request already
        // went out, so its answer is applied either way. Dropping it would
        // leave a registered server whose install command nothing ever shows.
        if (!res.ok || !res.data) {
          // Nothing was created, so this one is fair to try again the next time
          // somebody lands on this step.
          attempted.current.delete(m.sourceId);
          setFailed((p) => ({
            ...p,
            [m.sourceId]: res.ok
              ? "Deplo could not register that machine."
              : res.error,
          }));
          continue;
        }
        setFailed((p) => {
          if (!(m.sourceId in p)) return p;
          const next = { ...p };
          delete next[m.sourceId];
          return next;
        });
        setPending((prev) => ({
          ...prev,
          [m.sourceId]: {
            serverId: res.data!.server.id,
            name: res.data!.server.name,
            installCommand: res.data!.installCommand,
          },
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machines, canAddServers, attempted, setPending]);

  // ---- probe until the agent answers US ------------------------------
  /**
   * One machine's verdict. Shared by the poll and the two buttons, so a manual
   * re-check and an automatic tick can never disagree about what counts as
   * connected.
   */
  const probe = React.useCallback(
    async (sourceId: string, p: PendingMachine) => {
      const res = await gqlAction<
        { checkServerHealth: { status: string; statusMessage: string | null } },
        { status: string; statusMessage: string | null }
      >(CHECK_HEALTH, { id: p.serverId }, (d) => d.checkServerHealth);
      if (!res.ok) {
        // Includes the row being GONE (removed elsewhere, or the migration was
        // finished in another tab): the server says so, and saying it here beats
        // sitting on "Waiting for the agent" with nothing ever coming.
        setUnreachable((prev) => ({
          ...prev,
          [sourceId]: { status: "error", message: res.error },
        }));
        return;
      }
      const { status, statusMessage } = res.data!;
      // Still short of its agent: nothing has answered yet, which is the normal
      // state of a machine whose install command has not been run.
      if (status === "provisioning") {
        setUnreachable((prev) => {
          if (!(sourceId in prev)) return prev;
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
        return;
      }
      // ONLINE and nothing else. `warning` is "the agent is up but Docker is
      // unreachable", and Docker is precisely what exports a volume - a machine
      // in that state would pass the gate and copy nothing.
      if (status === "online") {
        setPending((prev) => {
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
        setUnreachable((prev) => {
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
        onResolved(sourceId, p.serverId, p.name);
        return;
      }
      setUnreachable((prev) => ({
        ...prev,
        [sourceId]: {
          status,
          message: statusMessage || "The agent did not answer.",
        },
      }));
    },
    [onResolved, setPending],
  );

  // Stops by itself: a resolved machine is removed from `pending`.
  React.useEffect(() => {
    const waiting = Object.entries(pending);
    if (waiting.length === 0) return;
    const timer = setInterval(() => {
      for (const [sourceId, p] of waiting) void probe(sourceId, p);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, probe]);

  // ---- the two things a person can do about a bad verdict -------------
  const runBusy = React.useCallback(
    async (sourceId: string, work: () => Promise<void>) => {
      setBusy((p) => ({ ...p, [sourceId]: true }));
      try {
        await work();
      } finally {
        setBusy((p) => {
          const next = { ...p };
          delete next[sourceId];
          return next;
        });
      }
    },
    [],
  );

  const saveAddress = (sourceId: string, p: PendingMachine) =>
    runBusy(sourceId, async () => {
      const address = (draft[sourceId] ?? "").trim();
      if (!address) return;
      const res = await gqlAction<
        { updateServerAddress: string | null },
        string | null
      >(
        CHANGE_ADDRESS,
        { id: p.serverId, address },
        (d) => d.updateServerAddress,
      );
      if (!res.ok) {
        // Verbatim: `updateServerAddress` dials the new address before it saves,
        // so its refusal IS the diagnosis - the port is still shut, or nothing
        // is there.
        setUnreachable((prev) => ({
          ...prev,
          [sourceId]: { status: "offline", message: res.error },
        }));
        return;
      }
      if (res.data) toast.warning(res.data);
      await probe(sourceId, p);
    });

  const checkAgain = (sourceId: string, p: PendingMachine) =>
    runBusy(sourceId, () => probe(sourceId, p));

  // ---- and then move on ---------------------------------------------
  React.useEffect(() => {
    if (!settled) return;
    const t = setTimeout(onDone, SETTLE_MS);
    return () => clearTimeout(t);
  }, [settled, onDone]);

  return (
    <StepShell
      title={
        settled ? "Every machine is connected" : "Run one line on each machine"
      }
      lead={
        settled
          ? "Deplo can read the disks it needs. Carrying on."
          : "Deplo copies your data by reading it on the machine that holds it, so it needs its agent on each one. Nothing else is installed there, and Deplo removes it for you when the migration is done."
      }
    >
      <div className="divide-y divide-border/60 rounded-lg border border-border">
        {machines.map((m) => {
          const p = pending[m.sourceId];
          const error = failed[m.sourceId];
          const bad = unreachable[m.sourceId];
          const working = busy[m.sourceId] === true;
          return (
            <div key={m.sourceId || "own"} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  {m.ipAddress && (
                    <span className="truncate text-xs text-muted-foreground">
                      {m.ipAddress}
                    </span>
                  )}
                </div>
                {m.deploServerId ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-success">
                    <Check className="size-3.5" />
                    Connected
                  </span>
                ) : error ? (
                  <span className="flex min-w-0 items-start gap-1.5 text-xs text-destructive">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0">{error}</span>
                  </span>
                ) : bad ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-destructive">
                    <TriangleAlert className="size-3.5" />
                    Deplo cannot reach this machine
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

              {p && bad && (
                <div className="space-y-2">
                  <CommandLine command={p.installCommand} truncate />
                  <p className="text-xs text-muted-foreground">
                    {bad.message}
                    {bad.status === "offline" ? ` ${AGENT_PORT_NOTICE}` : ""}
                  </p>
                  {bad.status === "offline" ? (
                    canAddServers ? (
                      <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveAddress(m.sourceId, p);
                        }}
                      >
                        <Input
                          value={draft[m.sourceId] ?? m.ipAddress ?? ""}
                          onChange={(e) =>
                            setDraft((prev) => ({
                              ...prev,
                              [m.sourceId]: e.target.value,
                            }))
                          }
                          placeholder="The machine's own address"
                          className="w-56"
                          disabled={working}
                        />
                        <Button type="submit" disabled={working}>
                          Save
                        </Button>
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
                      </form>
                    ) : (
                      <p className="text-xs text-warning">
                        Ask an instance admin to change its address.
                      </p>
                    )
                  ) : (
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
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </StepShell>
  );
}

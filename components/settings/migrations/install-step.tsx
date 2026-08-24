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

/**
 * What Deplo KNOWS when a probe comes back `offline`, and it is worth saying out
 * loud because the reader has just run a command and cannot tell whether it
 * worked.
 *
 * It worked. A row leaves `provisioning` only through `completeBootstrap`, which
 * fires on the agent's own call-home: the install ran, the binary started, the
 * token was consumed and a certificate was minted for it. So a row that has
 * reached this state has proven the install succeeded, and the ONLY thing that
 * failed is Deplo dialing back - a distinction the reader cannot make from
 * "cannot reach this machine" alone, and one that decides whether they go
 * re-run the installer (pointless) or open a port (the fix).
 *
 * Said only for `offline`. The other verdicts mean something answered, so the
 * install is not what is in question.
 */
const INSTALLED_BUT_UNREACHABLE =
  "Installed and calling home, but Deplo cannot reach it back.";

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

/**
 * The address row, shared by the two states that need one: a machine that could
 * not be registered, and one that was registered at an address Deplo cannot
 * reach. Same field, same rules, so it cannot drift into two spellings of the
 * same question.
 */
function AddressForm({
  value,
  onChange,
  onSubmit,
  submitLabel,
  onSecondary,
  secondaryLabel,
  working,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
  working: boolean;
}) {
  return (
    <>
      <form
        className="flex flex-row items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {/* EMPTY, never prefilled: the address we hold is the one that just
            failed, and handing it back invites a Save that changes nothing. The
            placeholder carries the shape, and BOTH shapes - an IP is the usual
            answer, a second DNS name that skips the proxy is just as good. */}
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="1.1.1.1 or host.example.com"
          className="w-full"
          disabled={working}
        />
        <Button type="submit" disabled={working || !value.trim()}>
          {submitLabel}
        </Button>
        {onSecondary && (
          <Button
            type="button"
            variant="outline"
            disabled={working}
            onClick={onSecondary}
          >
            {working ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              secondaryLabel
            )}
          </Button>
        )}
      </form>
      {/* The one mistake this screen invites, said where it would be made: the
          panel is reached at a name, the machine at an address, and they are the
          same thing only when nothing sits in front. */}
      <p className="text-xs text-muted-foreground">
        The machine&rsquo;s own address, not the panel&rsquo;s. An IP or a
        hostname that points straight at it.
      </p>
    </>
  );
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
  /** The panel this imports from - the key a corrected address is filed under. */
  sourceUrl: string;
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

  /**
   * Register one machine at `address`. The effect below calls it with the
   * address the scan worked out; a person calls it with the one they typed,
   * which is the ONLY way past a machine whose address Deplo could not work out
   * or whose registration was refused. Without that, the step blocked - which is
   * its job - with nothing on screen that could unblock it, which is not.
   */
  const registerMachine = React.useCallback(
    async (m: PlanServer, address: string) => {
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
            host: address,
            // A MIGRATION SOURCE, not a server: the install command touches
            // nothing on the box but the agent itself, the host stays out of
            // every picker and every sweep, and finishing the migration
            // uninstalls it again.
            importOnly: true,
          },
        },
        (d) => d.addServer,
      );
      if (!res.ok || !res.data) {
        // Nothing was created, so this one is fair to try again.
        attempted.current.delete(m.sourceId);
        setFailed((p) => ({
          ...p,
          [m.sourceId]: res.ok ? "Deplo could not register it." : res.error,
        }));
        return;
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
    },
    [attempted, setPending],
  );

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
          // Not a dead end any more: the row below offers the field that fixes
          // it. Marked attempted all the same, so the effect does not re-raise
          // this on every render while somebody is typing into it.
          setFailed((p) => ({
            ...p,
            [m.sourceId]: "Deplo could not work out that machine's address.",
          }));
          continue;
        }
        // One at a time rather than all at once: a failure has to be able to
        // name the machine it happened on, and two hosts registering in
        // parallel produce two toasts nobody can tell apart. Deliberately NOT
        // bailing on `cancelled` after the call: the request already went out,
        // so its answer is applied either way - dropping it would leave a
        // registered server whose install command nothing ever shows.
        await registerMachine(m, m.ipAddress);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machines, canAddServers, attempted, registerMachine]);

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
        // The row is GONE, most likely - removed elsewhere, or the migration was
        // finished in another tab. Probing it again can only fail the same way,
        // so the machine goes back to being unregistered: that state offers the
        // field that registers it, which is the only thing that can help. A
        // transient blip lands there too and is harmless, because `addServer`
        // refuses a second row at an address it already knows.
        setPending((prev) => {
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
        attempted.current.delete(sourceId);
        setUnreachable((prev) => {
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
        setFailed((prev) => ({ ...prev, [sourceId]: res.error }));
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
    [onResolved, setPending, attempted],
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

  /** Register a machine Deplo could not register itself, at a typed address. */
  const registerManually = (m: PlanServer) =>
    runBusy(m.sourceId, async () => {
      const address = (draft[m.sourceId] ?? "").trim();
      if (!address) return;
      attempted.current.add(m.sourceId);
      await registerMachine(m, address);
    });

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
          ? "Deplo can read the disks it needs."
          : "Deplo needs its agent on each machine to read your data. It takes it back off when the migration is done."
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

              {/* The command shows while it is the thing to DO, and stops the
                  moment it is not. An agent that called home and cannot be
                  reached back is installed correctly - handing back the line
                  that installs it says the opposite, and the next thing
                  somebody does is run it again for nothing. An `error` verdict
                  is the exception: there the agent answered with a certificate
                  or a protocol we refuse, and re-provisioning IS the cure. */}
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
                    {INSTALLED_BUT_UNREACHABLE} {AGENT_PORT_NOTICE}
                  </p>
                  <p className="text-xs text-muted-foreground">{bad.message}</p>
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

              {/* Never registered: no address to derive, or `addServer` refused
                  one. The step blocking is right; blocking with nothing on
                  screen that could unblock it is not, and that is what this was
                  until now. */}
              {!p && !m.deploServerId && error && (
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
        })}
      </div>
    </StepShell>
  );
}

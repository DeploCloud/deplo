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
import type { SourceKind } from "./sources";
import { AGENT_PORT_NOTICE } from "@/lib/agent-reachability";
import type { PlanServer } from "./types";

/**
 * Getting Deplo's agent onto the machines behind that Dokploy. For a long time the
 * gate did not gate.
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
 * A live probe, not a read of the stored row - the whole point of the gate.
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
 * The address is PROVED, then written down against the source - so the next
 * attempt registers the machine where it really is instead of at the panel's
 * name. `keepHost` (inside) keeps the row recognisable on that second pass.
 */
const CHANGE_ADDRESS = /* GraphQL */ `
  mutation SetMigrationMachineAddress(
    $url: String!
    $sourceId: String!
    $id: String!
    $address: String!
  ) {
    setMigrationMachineAddress(
      url: $url
      sourceId: $sourceId
      serverId: $id
      address: $address
    )
  }
`;

/**
 * A machine Deplo already has a row for, but whose agent has never answered - what
 * a first attempt that failed leaves behind. Its command has to come back, or the
 * only way past this step is deleting the server by hand.
 */
const REISSUE = /* GraphQL */ `
  mutation ReissueMigrationBootstrap($id: String!) {
    reissueServerBootstrap(id: $id) {
      server {
        id
        name
      }
      installCommand
    }
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
 */
const INSTALLED_BUT_UNREACHABLE =
  "Installed and calling home, but Deplo cannot reach it back.";

/**
 * The other reason nothing answers at that address, and the one this wizard causes
 * itself: the first guess is the panel's own hostname, which behind a proxy or a
 * CDN is that proxy rather than the machine.
 */
const PANEL_ADDRESS_NOTICE =
  "If the panel sits behind a proxy or a CDN, this address is the proxy, not the machine.";

/** What the probe said, for a machine that answered badly or not at all. */
interface Unreachable {
  /** `offline` (nothing answered) or `error` (answered, but not as itself). */
  status: string;
  /** The server's own sentence, shown verbatim. */
  message: string;
}

/**
 * A machine Deplo has registered and is now waiting to hear from.
 */
export interface PendingMachine {
  serverId: string;
  name: string;
  installCommand: string;
}

/**
 * The address row, shared by the two states that need one: a machine that could
 * not be registered, and one that was registered at an address Deplo cannot reach.
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
        {/**
         * EMPTY, never prefilled: the address we hold is the one that just failed, and
         * handing it back invites a Save that changes nothing.
         */}
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
  kind,
  sourceUrl,
  machines,
  canAddServers,
  pending,
  setPending,
  attempted,
  onResolved,
  onDone,
}: {
  /** Which panel these machines belong to. */
  kind: SourceKind | null;
  /** The panel this imports from - the key a corrected address is filed under. */
  sourceUrl: string;
  machines: PlanServer[];
  /** Registering a host is instance-admin only, like everywhere else. */
  canAddServers: boolean;
  /** Registered, waiting to be heard from. The wizard holds it - see above. */
  pending: Record<string, PendingMachine>;
  setPending: React.Dispatch<
    React.SetStateAction<Record<string, PendingMachine>>
  >;
  /**
   * Which machines have been through `addServer` already, so revisiting this step
   * never registers one twice.
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
  /** Machines whose address somebody has opened for editing by hand. */
  const [editing, setEditing] = React.useState<Record<string, boolean>>({});

  // Having a row is not being connected: a first attempt that failed leaves one
  // behind at the same address, and taking it for a machine Deplo can read is what
  // made the retry skip this step and die in the data phase.
  const missing = machines.filter((m) => !m.deploServerOnline);
  const settled = missing.length === 0;

  /**
   * Register one machine at `address`.
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
            name: m.sourceId ? m.name : `${kind ?? "source"}-host`,
            host: address,
            // A MIGRATION SOURCE, not a server: the install command touches nothing on the box
            // but the agent itself, the host stays out of every picker and every sweep, and
            // finishing the migration uninstalls it again.
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
    [attempted, setPending, kind],
  );

  /**
   * A machine Deplo already has a row for that has never answered: ask for its
   * install command back, so this step can be driven again instead of dead-ending
   * on a row only Settings -> Servers can remove.
   */
  const reclaimMachine = React.useCallback(
    async (m: PlanServer) => {
      const res = await gqlAction<
        {
          reissueServerBootstrap: {
            server: { id: string; name: string };
            installCommand: string;
          };
        },
        { server: { id: string; name: string }; installCommand: string }
      >(REISSUE, { id: m.deploServerId }, (d) => d.reissueServerBootstrap);
      if (!res.ok || !res.data) {
        attempted.current.delete(m.sourceId);
        setFailed((p) => ({
          ...p,
          [m.sourceId]: res.ok
            ? "Deplo could not mint a new install command."
            : res.error,
        }));
        return;
      }
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
        // Checked BEFORE the machine is marked attempted: a resolved machine rewrites
        // `machines`, which re-runs this effect and cancels the old one, and a machine
        // claimed by a run that then stops would never be registered by anybody.
        if (cancelled) return;
        if (m.deploServerOnline || attempted.current.has(m.sourceId)) continue;
        attempted.current.add(m.sourceId);
        if (m.deploServerId) {
          await reclaimMachine(m);
          continue;
        }
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
        // One at a time rather than all at once: a failure has to be able to name the
        // machine it happened on, and two hosts registering in parallel produce two toasts
        // nobody can tell apart.
        await registerMachine(m, m.ipAddress);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machines, canAddServers, attempted, registerMachine, reclaimMachine]);

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
        // The row is GONE, most likely - removed elsewhere, or the migration was finished
        // in another tab. A transient blip lands there too and is harmless, because
        // `addServer` refuses a second row at an address it already knows.
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

  /**
   * Point Deplo at a different address for this machine, and REMEMBER it. Offered
   * for a connected machine too: a row that answers can still be the wrong box,
   * and the only sign of that used to be every volume "having no data yet".
   */
  const saveAddress = (sourceId: string, p: PendingMachine) =>
    runBusy(sourceId, async () => {
      const address = (draft[sourceId] ?? "").trim();
      if (!address) return;
      const res = await gqlAction<
        { setMigrationMachineAddress: string | null },
        string | null
      >(
        CHANGE_ADDRESS,
        { url: sourceUrl, sourceId, id: p.serverId, address },
        (d) => d.setMigrationMachineAddress,
      );
      if (!res.ok) {
        // Verbatim: the mutation dials the new address before it saves, so its
        // refusal IS the diagnosis - the port is still shut, or nothing is there.
        // A machine with no command on screen has nowhere to show that, so it says
        // it out loud instead.
        if (!pending[sourceId]) toast.error(res.error);
        setUnreachable((prev) => ({
          ...prev,
          [sourceId]: { status: "offline", message: res.error },
        }));
        return;
      }
      if (!pending[sourceId])
        toast.success(`${p.name} now answers at ${address}.`);
      if (res.data) toast.warning(res.data);
      setEditing((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
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

              {/**
               * The command shows while it is the thing to DO, and stops the moment it is not.
               */}
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
                    {INSTALLED_BUT_UNREACHABLE} {AGENT_PORT_NOTICE}{" "}
                    {PANEL_ADDRESS_NOTICE}
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

              {m.deploServerOnline &&
                editing[m.sourceId] &&
                m.deploServerId && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      A machine that answers can still be the wrong one. Every
                      volume of the services on it would arrive empty.
                    </p>
                    <AddressForm
                      value={draft[m.sourceId] ?? ""}
                      onChange={(v) =>
                        setDraft((prev) => ({ ...prev, [m.sourceId]: v }))
                      }
                      onSubmit={() =>
                        void saveAddress(m.sourceId, {
                          serverId: m.deploServerId!,
                          name: m.deploServerName ?? m.name,
                          installCommand: "",
                        })
                      }
                      submitLabel="Save"
                      working={working}
                    />
                  </div>
                )}

              {/**
               * Never registered: no address to derive, or `addServer` refused one.
               */}
              {!p && !m.deploServerOnline && error && (
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

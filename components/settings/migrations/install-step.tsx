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
import { cn } from "@/lib/utils";
import { CommandLine } from "@/components/shared/code-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StepShell } from "./step-shell";
import type { SourceKind } from "./sources";
import { AGENT_PORT_NOTICE } from "@/lib/agent-reachability";
import type { PlanServer } from "./types";
import { twinAt } from "./machines";

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
        role
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
 * What a probe coming back `offline` means, said out loud because the reader has
 * just run a command and cannot tell whether it worked. Never "installed": the
 * agent may also have been taken off since the last walk.
 */
const AGENT_UNREACHABLE = "Deplo cannot reach the agent on this machine.";

/**
 * The other reason nothing answers at that address, and the one this wizard causes
 * itself: the first guess is the panel's own hostname, which behind a proxy or a
 * CDN is that proxy rather than the machine.
 */
const PANEL_ADDRESS_NOTICE =
  "A proxy in front of the panel answers here, not the machine.";

/**
 * The same thing, said once Deplo has actually SEEN it - the panel's name resolves
 * into Cloudflare's ranges, so no agent will ever answer there. Raised BEFORE the
 * install command, since the address is already known to be wrong. What to type
 * instead is the address field's own line, right under it.
 */
const CLOUDFLARE_ADDRESS_NOTICE =
  "This address is Cloudflare's, not the machine's.";

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
  /** Where it was registered - the typed IP, not the panel's name. */
  address: string;
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
          placeholder="203.0.113.10"
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
      {/* The mistake this screen invites, said where it would be made: the panel is
          reached at a name, the machine at an IP. A name pointing straight at the
          machine works too - https://deplo.build/docs/migrations/move-from-dokploy */}
      <p className="text-xs text-muted-foreground">
        The machine&rsquo;s own IP address, not the panel&rsquo;s.
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
  onBack,
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
   * Which machines have a registration IN FLIGHT, so a re-render never starts a
   * second one. Cleared when it lands: what happened then is in `pending` or in
   * this step's own state, and a machine with neither is fair to try again.
   */
  attempted: React.RefObject<Set<string>>;
  /** One machine just came online: it now maps to this Deplo server, dialed
   *  at `address` when one was typed. */
  onResolved: (
    sourceId: string,
    serverId: string,
    serverName: string,
    address?: string,
  ) => void;
  /** Every machine is ours. Carry on to the review. */
  onDone: () => void;
  /** Back to Connect: nothing here has been written yet. */
  onBack?: () => void;
}) {
  const [failed, setFailed] = React.useState<Record<string, string>>({});
  /** Machines Deplo already reaches, waiting for somebody to say "use that one". */
  const [adoptable, setAdoptable] = React.useState<
    Record<string, { serverId: string; name: string }>
  >({});
  const [unreachable, setUnreachable] = React.useState<
    Record<string, Unreachable>
  >({});
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  /** Machines whose address somebody has opened for editing by hand. */
  const [editing, setEditing] = React.useState<Record<string, boolean>>({});

  /**
   * Take a server Deplo already reaches as this source's machine, and REMEMBER
   * the address against it so the next pass matches the row instead of asking.
   */
  const claim = React.useCallback(
    async (
      sourceId: string,
      address: string,
      hit: { serverId: string; name: string },
    ) => {
      const res = await gqlAction<
        { setMigrationMachineAddress: string | null },
        string | null
      >(
        CHANGE_ADDRESS,
        { url: sourceUrl, sourceId, id: hit.serverId, address },
        (d) => d.setMigrationMachineAddress,
      );
      if (!res.ok) {
        attempted.current.delete(sourceId);
        setFailed((p) => ({ ...p, [sourceId]: res.error }));
        return;
      }
      if (res.data) toast.warning(res.data);
      onResolved(sourceId, hit.serverId, hit.name, address);
    },
    [sourceUrl, attempted, onResolved],
  );

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
            server: { id: string; name: string; role: string };
            installCommand: string;
          };
        },
        {
          server: { id: string; name: string; role: string };
          installCommand: string;
        }
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
      // No command means Deplo already reaches that address. A migration source
      // is nobody's production server, so it is taken as this machine; a fleet
      // server is offered, never adopted for somebody.
      if (!res.data.installCommand) {
        const hit = {
          serverId: res.data.server.id,
          name: res.data.server.name,
        };
        if (res.data.server.role === "import") {
          await claim(m.sourceId, address, hit);
          return;
        }
        setAdoptable((prev) => ({ ...prev, [m.sourceId]: hit }));
        return;
      }
      setPending((prev) => ({
        ...prev,
        [m.sourceId]: {
          serverId: res.data!.server.id,
          name: res.data!.server.name,
          installCommand: res.data!.installCommand,
          address,
        },
      }));
    },
    [attempted, setPending, kind, claim],
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
          address: m.ipAddress ?? "",
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
        const id = m.sourceId;
        // Left alone while something is in flight or already said: a stale
        // "attempted" with nothing to show for it was a row on "Registering" for
        // ever after a Back and a second scan.
        if (
          m.deploServerOnline ||
          attempted.current.has(id) ||
          pending[id] ||
          failed[id] ||
          adoptable[id] ||
          unreachable[id]
        )
          continue;
        attempted.current.add(id);
        if (m.deploServerId) {
          try {
            await reclaimMachine(m);
          } finally {
            attempted.current.delete(id);
          }
          continue;
        }
        // A Cloudflare address is known to be the proxy, so registering there would
        // only mint an install command that can never answer. Not a dead end any
        // more either way: the row below offers the field that fixes it. Marked
        // attempted all the same, so the effect does not re-raise this on every
        // render while somebody is typing into it.
        if (!m.ipAddress || m.cloudflare) {
          attempted.current.delete(id);
          setFailed((p) => ({
            ...p,
            [id]: m.cloudflare
              ? CLOUDFLARE_ADDRESS_NOTICE
              : "Deplo could not work out that machine's address.",
          }));
          continue;
        }
        // One at a time rather than all at once: a failure has to be able to name the
        // machine it happened on, and two hosts registering in parallel produce two toasts
        // nobody can tell apart.
        try {
          await registerMachine(m, m.ipAddress);
        } finally {
          attempted.current.delete(id);
        }
      }
    })().catch((e: unknown) => {
      // A row left on "Registering" with nothing to say is the one dead end a
      // person cannot get out of.
      for (const m of machines)
        if (!m.deploServerOnline && attempted.current.has(m.sourceId)) {
          attempted.current.delete(m.sourceId);
          setFailed((p) => ({
            ...p,
            [m.sourceId]: e instanceof Error ? e.message : String(e),
          }));
        }
    });
    return () => {
      cancelled = true;
    };
  }, [
    machines,
    canAddServers,
    attempted,
    registerMachine,
    reclaimMachine,
    pending,
    failed,
    adoptable,
    unreachable,
  ]);

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
        onResolved(sourceId, p.serverId, p.name, p.address);
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

  /** Take a fleet server Deplo already reaches as this source's machine. */
  const adopt = (m: PlanServer, hit: { serverId: string; name: string }) =>
    runBusy(m.sourceId, () =>
      claim(
        m.sourceId,
        (draft[m.sourceId] ?? "").trim() || m.ipAddress || "",
        hit,
      ),
    );

  /**
   * Register a machine Deplo could not register itself, at a typed address. An
   * address another machine of the list sits at IS that machine, so this row joins
   * that one rather than registering it twice (which re-minted its command).
   */
  const registerManually = (m: PlanServer) =>
    runBusy(m.sourceId, async () => {
      const address = (draft[m.sourceId] ?? "").trim();
      if (!address) return;
      attempted.current.add(m.sourceId);
      try {
        await registerAt(m, address);
      } finally {
        attempted.current.delete(m.sourceId);
      }
    });

  /** The manual registration itself - see `registerManually`. */
  const registerAt = async (m: PlanServer, address: string) => {
    {
      const twin = twinAt(machines, m.sourceId, address);
      if (twin?.deploServerOnline && twin.deploServerId) {
        await claim(m.sourceId, address, {
          serverId: twin.deploServerId,
          name: twin.deploServerName ?? twin.name,
        });
        return;
      }
      const shared = twin ? pending[twin.sourceId] : undefined;
      if (shared) {
        // Remembered now, so the next pass matches this row too; the row has no
        // agent yet, so nothing is dialed.
        await gqlAction(CHANGE_ADDRESS, {
          url: sourceUrl,
          sourceId: m.sourceId,
          id: shared.serverId,
          address,
        });
        setFailed((p) => {
          const next = { ...p };
          delete next[m.sourceId];
          return next;
        });
        setPending((prev) => ({ ...prev, [m.sourceId]: shared }));
        return;
      }
      await registerMachine(m, address);
    }
  };

  // ---- and then move on ---------------------------------------------
  // Only when it BECOMES settled here: a person who came back to this step
  // (Back from Review, Change address) must not be thrown forward again.
  const settledOnMount = React.useRef(settled);
  React.useEffect(() => {
    if (!settled || settledOnMount.current) return;
    const t = setTimeout(onDone, SETTLE_MS);
    return () => clearTimeout(t);
  }, [settled, onDone]);

  return (
    <StepShell
      hero
      title={
        settled ? "Every machine is connected" : "Run one line on each machine"
      }
      lead={
        settled
          ? "Deplo can read the disks it needs."
          : "Sign in to each machine as root and paste its line. Deplo needs its agent there to read your data, and takes it back off when the migration is done."
      }
    >
      <div className="divide-y divide-border/60 rounded-lg border border-border bg-background">
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
                    {AGENT_UNREACHABLE}{" "}
                    {m.cloudflare
                      ? CLOUDFLARE_ADDRESS_NOTICE
                      : `${AGENT_PORT_NOTICE} ${PANEL_ADDRESS_NOTICE}`}
                  </p>
                  <p className="text-xs text-muted-foreground">{bad.message}</p>
                  {/* Both ways out: the line to run when the agent is not there
                      at all, and the address when it is. */}
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
                          address: m.ipAddress ?? "",
                        })
                      }
                      submitLabel="Save"
                      working={working}
                    />
                  </div>
                )}

              {/**
               * Nothing to install here - the machine is already one of Deplo's.
               */}
              {!p && !m.deploServerOnline && adoptable[m.sourceId] && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Deplo already reaches this machine as{" "}
                    {adoptable[m.sourceId].name}. Nothing to install.
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

              {/**
               * Never registered: no address to derive, or `addServer` refused one.
               */}
              {!p &&
                !m.deploServerOnline &&
                !adoptable[m.sourceId] &&
                error && (
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

      {/* A step that was settled when it opened does not move on by itself (see
          above), so it says how: a second migration from the same panel finds
          every machine already answering and used to end here with no way out. */}
      {settled && (
        <div className={cn("flex", onBack ? "justify-between" : "justify-end")}>
          {onBack && (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
          <Button onClick={onDone}>Continue</Button>
        </div>
      )}
    </StepShell>
  );
}

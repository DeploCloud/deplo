"use client";

import * as React from "react";
import { toast } from "sonner";

import { gqlAction } from "@/lib/graphql-client";
import type { SourceKind } from "../sources";
import type { PlanServer } from "../types";
import { twinAt } from "../machines";
import { ADD_SERVER, CHANGE_ADDRESS, CHECK_HEALTH, REISSUE } from "./mutations";
import {
  CLOUDFLARE_ADDRESS_NOTICE,
  type PendingMachine,
  type Unreachable,
} from "./machine-state";

const POLL_MS = 6000;

export interface MachineInstall {
  settled: boolean;
  pending: Record<string, PendingMachine>;
  failed: Record<string, string>;
  adoptable: Record<string, { serverId: string; name: string }>;
  unreachable: Record<string, Unreachable>;
  busy: Record<string, boolean>;
  draft: Record<string, string>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  editing: Record<string, boolean>;
  setEditing: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  saveAddress: (sourceId: string, p: PendingMachine) => Promise<void>;
  checkAgain: (sourceId: string, p: PendingMachine) => Promise<void>;
  adopt: (
    m: PlanServer,
    hit: { serverId: string; name: string },
  ) => Promise<void>;
  registerManually: (m: PlanServer) => Promise<void>;
}

export function useMachineInstall({
  kind,
  sourceUrl,
  machines,
  canAddServers,
  pending,
  setPending,
  attempted,
  onResolved,
}: {
  kind: SourceKind | null;
  sourceUrl: string;
  machines: PlanServer[];
  canAddServers: boolean;
  pending: Record<string, PendingMachine>;
  setPending: React.Dispatch<
    React.SetStateAction<Record<string, PendingMachine>>
  >;
  attempted: React.RefObject<Set<string>>;
  onResolved: (
    sourceId: string,
    serverId: string,
    serverName: string,
    address?: string,
  ) => void;
}): MachineInstall {
  const [failed, setFailed] = React.useState<Record<string, string>>({});
  const [adoptable, setAdoptable] = React.useState<
    Record<string, { serverId: string; name: string }>
  >({});
  const [unreachable, setUnreachable] = React.useState<
    Record<string, Unreachable>
  >({});
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  const [editing, setEditing] = React.useState<Record<string, boolean>>({});

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

  const missing = machines.filter((m) => !m.deploServerOnline);
  const settled = missing.length === 0;

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
            importOnly: true,
          },
        },
        (d) => d.addServer,
      );
      if (!res.ok || !res.data) {
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

  React.useEffect(() => {
    if (!canAddServers) return;
    let cancelled = false;
    (async () => {
      for (const m of machines) {
        if (cancelled) return;
        const id = m.sourceId;
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
        try {
          await registerMachine(m, m.ipAddress);
        } finally {
          attempted.current.delete(id);
        }
      }
    })().catch((e: unknown) => {
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

  const probe = React.useCallback(
    async (sourceId: string, p: PendingMachine) => {
      const res = await gqlAction<
        { checkServerHealth: { status: string; statusMessage: string | null } },
        { status: string; statusMessage: string | null }
      >(CHECK_HEALTH, { id: p.serverId }, (d) => d.checkServerHealth);
      if (!res.ok) {
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
      if (status === "provisioning") {
        setUnreachable((prev) => {
          if (!(sourceId in prev)) return prev;
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
        return;
      }
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

  React.useEffect(() => {
    const waiting = Object.entries(pending);
    if (waiting.length === 0) return;
    const timer = setInterval(() => {
      for (const [sourceId, p] of waiting) void probe(sourceId, p);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, probe]);

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
        { setMigrationMachineAddress: string | null },
        string | null
      >(
        CHANGE_ADDRESS,
        { url: sourceUrl, sourceId, id: p.serverId, address },
        (d) => d.setMigrationMachineAddress,
      );
      if (!res.ok) {
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

  const adopt = (m: PlanServer, hit: { serverId: string; name: string }) =>
    runBusy(m.sourceId, () =>
      claim(
        m.sourceId,
        (draft[m.sourceId] ?? "").trim() || m.ipAddress || "",
        hit,
      ),
    );

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

  return {
    settled,
    pending,
    failed,
    adoptable,
    unreachable,
    busy,
    draft,
    setDraft,
    editing,
    setEditing,
    saveAddress,
    checkAgain,
    adopt,
    registerManually,
  };
}

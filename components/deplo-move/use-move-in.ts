"use client";

import * as React from "react";
import { toast } from "sonner";

import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { TargetMovePreview } from "@/lib/data/deplo-move/target";

const CONNECT_DEPLO_MOVE = /* GraphQL */ `
  mutation ConnectDeploMove($url: String!, $code: String!) {
    connectDeploMove(url: $url, code: $code) {
      id
      peerUrl
      version
      canStart
      problems
      warnings
      counts {
        teams
        users
        apps
        databases
        servers
      }
      servers {
        id
        name
        address
        port
        role
        isPanelHost
        enrolled
        reachable
        agentVersion
        apps
        databases
        databaseHosts {
          id
          name
          host
        }
        target
        choices
        problem
      }
      targets {
        id
        name
        address
        isThisMachine
        canHostWorkloads
      }
    }
  }
`;

const START_DEPLO_MOVE = /* GraphQL */ `
  mutation StartDeploMove($id: String!, $map: [DeploMoveServerMapInput!]) {
    startDeploMove(id: $id, map: $map) {
      id
      state
    }
  }
`;

export type MoveIn = ReturnType<typeof useMoveIn>;

// Old server id -> the server here it lands on.
export type ServerMap = Record<string, string>;

function defaultMap(preview: TargetMovePreview | null): ServerMap {
  const map: ServerMap = {};
  for (const s of preview?.servers ?? []) if (s.target) map[s.id] = s.target;
  return map;
}

// Lives in the wizard, so the address and code survive a step back to Source.
export function useMoveIn() {
  const router = useRouter();
  const [url, setUrlValue] = React.useState("");
  const [code, setCodeValue] = React.useState("");
  const [preview, setPreviewValue] = React.useState<TargetMovePreview | null>(
    null,
  );
  const [map, setMap] = React.useState<ServerMap>({});
  const [connecting, setConnecting] = React.useState(false);
  const filled = url.trim() !== "" && code.trim() !== "";

  const setPreview = (p: TargetMovePreview | null) => {
    setPreviewValue(p);
    // A choice still on offer survives "Check again"; anything else falls back to the default.
    setMap((was) => {
      const next = defaultMap(p);
      for (const s of p?.servers ?? [])
        if (was[s.id] && s.choices.includes(was[s.id])) next[s.id] = was[s.id];
      return next;
    });
  };
  const setUrl = (v: string) => {
    setUrlValue(v);
    setPreview(null);
  };
  const setCode = (v: string) => {
    setCodeValue(v);
    setPreview(null);
  };
  const setTarget = (from: string, to: string) =>
    setMap((m) => ({ ...m, [from]: to }));

  async function connect(): Promise<boolean> {
    if (!filled) return false;
    setConnecting(true);
    const res = await gqlAction<{ connectDeploMove: TargetMovePreview }>(
      CONNECT_DEPLO_MOVE,
      { url: url.trim(), code: code.trim() },
    );
    setConnecting(false);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    setPreview(res.data?.connectDeploMove ?? null);
    return true;
  }

  async function start() {
    const id = preview?.id ?? "";
    const res = await gqlAction(START_DEPLO_MOVE, {
      id,
      map: Object.entries(map).map(([from, to]) => ({ from, to })),
    });
    if (res.ok) router.push(`/moving/${id}`);
    return res;
  }

  return {
    url,
    setUrl,
    code,
    setCode,
    preview,
    map,
    setTarget,
    connecting,
    filled,
    connect,
    start,
  };
}

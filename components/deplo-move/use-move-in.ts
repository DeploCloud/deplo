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
        agentVersion
        apps
        databases
        problem
      }
    }
  }
`;

const START_DEPLO_MOVE = /* GraphQL */ `
  mutation StartDeploMove($id: String!) {
    startDeploMove(id: $id) {
      id
      state
    }
  }
`;

export type MoveIn = ReturnType<typeof useMoveIn>;

// Lives in the wizard, so the address and code survive a step back to Source.
export function useMoveIn() {
  const router = useRouter();
  const [url, setUrlValue] = React.useState("");
  const [code, setCodeValue] = React.useState("");
  const [preview, setPreview] = React.useState<TargetMovePreview | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const filled = url.trim() !== "" && code.trim() !== "";

  const setUrl = (v: string) => {
    setUrlValue(v);
    setPreview(null);
  };
  const setCode = (v: string) => {
    setCodeValue(v);
    setPreview(null);
  };

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
    const res = await gqlAction(START_DEPLO_MOVE, { id });
    if (res.ok) router.push(`/moving/${id}`);
    return res;
  }

  return {
    url,
    setUrl,
    code,
    setCode,
    preview,
    connecting,
    filled,
    connect,
    start,
  };
}

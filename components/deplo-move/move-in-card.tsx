"use client";

import * as React from "react";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import { toast } from "sonner";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { TargetMovePreview } from "@/lib/data/deplo-move/target";
import { MovePreview } from "./move-preview";

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

export function MoveInCard({
  activeId,
  readiness,
}: {
  // A move into this Deplo that has already started.
  activeId: string | null;
  readiness: { ready: boolean; reason: string | null };
}) {
  const router = useRouter();
  const [url, setUrl] = React.useState("");
  const [code, setCode] = React.useState("");
  const [preview, setPreview] = React.useState<TargetMovePreview | null>(null);
  const [connecting, startConnecting] = React.useTransition();
  const filled = url.trim() !== "" && code.trim() !== "";

  function connect() {
    if (!filled) return;
    startConnecting(async () => {
      const res = await gqlAction<{ connectDeploMove: TargetMovePreview }>(
        CONNECT_DEPLO_MOVE,
        { url: url.trim(), code: code.trim() },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPreview(res.data?.connectDeploMove ?? null);
    });
  }

  async function start() {
    const id = preview?.id ?? "";
    const res = await gqlAction(START_DEPLO_MOVE, { id });
    if (res.ok) router.push(`/moving/${id}`);
    return res;
  }

  const description = activeId
    ? "A move into this Deplo is under way."
    : !readiness.ready
      ? readiness.reason
      : "Bring a whole Deplo onto this one with the move code it shows.";

  return (
    <Card>
      <SettingItem
        icon={ArrowDownToLine}
        title="Move another Deplo here"
        info="Only into a fresh Deplo: everything here is replaced by the old one's data."
        docs="deplo.move"
        description={description}
        control={
          activeId && (
            <Button size="sm" asChild>
              <Link href={`/moving/${activeId}`}>Show progress</Link>
            </Button>
          )
        }
      >
        {!activeId && readiness.ready && (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              connect();
            }}
          >
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="move-url"
                info="Its https address: a move carries every secret, so it never runs over plain http."
              >
                Old Deplo address
              </FieldLabel>
              <Input
                id="move-url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setPreview(null);
                }}
                placeholder="https://deplo.example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="move-code"
                info="Create it on the old Deplo, under Settings, Migrations, Move Deplo."
              >
                Move code
              </FieldLabel>
              <Input
                id="move-code"
                type="password"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setPreview(null);
                }}
                placeholder="dmove_…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <Button type="submit" disabled={connecting || !filled}>
              {connecting && <Loader2 className="size-4 animate-spin" />}
              Connect
            </Button>
          </form>
        )}
        {!activeId && readiness.ready && preview && (
          <MovePreview
            preview={preview}
            checking={connecting}
            onCheckAgain={connect}
            onStart={start}
          />
        )}
      </SettingItem>
    </Card>
  );
}

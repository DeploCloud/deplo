"use client";

import * as React from "react";
import { ArrowUpFromLine, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CopyButton } from "@/components/shared/copy-button";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { SourceMoveStatus } from "@/lib/data/deplo-move/source";
import { PeerLink } from "./peer-link";

const SOURCE_MOVE = /* GraphQL */ `
  query SourceMove {
    sourceMove {
      id
      state
      peerUrl
      expiresAt
      handedOver
      servers
      startedBy
      createdAt
    }
  }
`;

const CREATE_MOVE_CODE = /* GraphQL */ `
  mutation CreateMoveCode {
    createMoveCode {
      code
      expiresAt
    }
  }
`;

const CANCEL_MOVE_CODE = /* GraphQL */ `
  mutation CancelMoveCode($force: Boolean) {
    cancelMoveCode(force: $force)
  }
`;

const POLL_MS = 3_000;

export function MoveOutCard({
  initial,
  incoming,
}: {
  initial: SourceMoveStatus | null;
  // A move INTO this Deplo is under way, so this one cannot leave.
  incoming: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = React.useState(initial);
  const [code, setCode] = React.useState<string | null>(null);
  // A plain cancel was refused: a server may already answer to the new Deplo.
  const [forwardOnly, setForwardOnly] = React.useState(false);
  const [creating, startCreating] = React.useTransition();
  const state = status?.state ?? null;

  const refetch = React.useCallback(async () => {
    const res = await gqlAction<{ sourceMove: SourceMoveStatus | null }>(
      SOURCE_MOVE,
    );
    if (!res.ok) return null;
    const next = res.data?.sourceMove ?? null;
    setStatus(next);
    return next;
  }, []);

  React.useEffect(() => {
    if (!state || state === "moved") return;
    const timer = setInterval(async () => {
      const next = (await refetch())?.state ?? null;
      // The dashboard itself changes when this Deplo pauses, resumes or has moved.
      if (
        next !== state &&
        [state, next].some((s) => s === "frozen" || s === "moved")
      )
        router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state, refetch, router]);

  function create() {
    startCreating(async () => {
      const res = await gqlAction<{
        createMoveCode: { code: string; expiresAt: string };
      }>(CREATE_MOVE_CODE);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCode(res.data?.createMoveCode.code ?? null);
      await refetch();
    });
  }

  async function cancel(force = false) {
    const res = await gqlAction(CANCEL_MOVE_CODE, { force });
    if (res.ok) {
      setCode(null);
      setStatus(null);
      setForwardOnly(false);
      router.refresh();
    } else if (state === "frozen") setForwardOnly(true);
    return res;
  }

  // The code is no use once a new Deplo has bound it.
  const shownCode = state === "armed" ? code : null;
  const cancellable =
    state === "armed" ||
    state === "bound" ||
    (state === "frozen" && status?.handedOver === 0 && !forwardOnly);
  const resumable = state === "frozen" && !cancellable;

  const canCreate =
    !incoming && (state === null || (state === "armed" && !shownCode));

  return (
    <Card>
      <SettingItem
        icon={ArrowUpFromLine}
        title="Move this Deplo"
        info="Copies every team, app and setting to a fresh Deplo on another machine, then hands every server over to it. Apps keep running."
        docs="deplo.move"
        description={
          <OutStatus
            status={status}
            hasCode={!!shownCode}
            incoming={incoming}
          />
        }
        control={
          (canCreate || cancellable || resumable) && (
            <>
              {canCreate && (
                <Button size="sm" onClick={create} disabled={creating}>
                  {creating && <Loader2 className="size-4 animate-spin" />}
                  Create move code
                </Button>
              )}
              {cancellable && (
                <ConfirmAction
                  trigger={
                    <Button size="sm" variant="outline">
                      Cancel move
                    </Button>
                  }
                  title="Cancel the move?"
                  description={
                    state === "armed"
                      ? "The move code stops working at once."
                      : "The new Deplo is cut off, and changes resume here."
                  }
                  confirmLabel="Cancel move"
                  successMessage="Move cancelled"
                  onConfirm={() => cancel()}
                />
              )}
              {resumable && (
                <ConfirmAction
                  trigger={
                    <Button size="sm" variant="outline">
                      Resume this Deplo
                    </Button>
                  }
                  title="Resume this Deplo?"
                  description={
                    <>
                      The move stops and changes resume here. Only do this if{" "}
                      <strong>the new Deplo is gone</strong>.
                    </>
                  }
                  consequence="Servers already handed over keep answering to the new Deplo and must be added here again."
                  confirmLabel="Resume this Deplo"
                  successMessage="This Deplo resumed"
                  onConfirm={() => cancel(true)}
                />
              )}
            </>
          )
        }
      >
        {shownCode && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
              {shownCode}
            </code>
            <CopyButton value={shownCode} />
          </div>
        )}
      </SettingItem>
    </Card>
  );
}

function OutStatus({
  status,
  hasCode,
  incoming,
}: {
  status: SourceMoveStatus | null;
  hasCode: boolean;
  incoming: boolean;
}) {
  if (!status)
    return incoming ? (
      <>Not while another Deplo is moving here.</>
    ) : (
      <>Create a move code, then paste it on the new Deplo.</>
    );
  const peer = status.peerUrl ? <PeerLink url={status.peerUrl} /> : null;
  switch (status.state) {
    case "armed":
      return (
        <>
          {hasCode
            ? "Paste this code on the new Deplo. It is shown only once."
            : "A move code is waiting for the new Deplo."}{" "}
          {status.expiresAt && <Expiry at={status.expiresAt} />}
        </>
      );
    case "bound":
      return <>Connected from {peer}. Start the move there.</>;
    case "frozen":
      return (
        <>
          Moving to {peer} - {status.handedOver} of {status.servers}{" "}
          {status.servers === 1 ? "server" : "servers"} handed over.
        </>
      );
    case "moved":
      return <>Moved to {peer}.</>;
  }
}

function Expiry({ at }: { at: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const minutes = Math.ceil((Date.parse(at) - now) / 60_000);
  return (
    <span suppressHydrationWarning>
      {minutes > 0 ? `Expires in ${minutes} min.` : "Expired."}
    </span>
  );
}

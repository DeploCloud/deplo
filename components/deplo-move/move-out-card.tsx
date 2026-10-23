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
      startedBy
      createdAt
      finishedAt
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
  mutation CancelMoveCode {
    cancelMoveCode
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
  const [creating, startCreating] = React.useTransition();
  const state = status?.state ?? null;

  const refetch = React.useCallback(async () => {
    const res = await gqlAction<{ sourceMove: SourceMoveStatus | null }>(
      SOURCE_MOVE,
    );
    if (res.ok) setStatus(res.data?.sourceMove ?? null);
  }, []);

  // Nothing here pauses for a copy, so only this card follows it.
  React.useEffect(() => {
    if (!state || state === "done") return;
    const timer = setInterval(refetch, POLL_MS);
    return () => clearInterval(timer);
  }, [state, refetch]);

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

  async function cancel() {
    const res = await gqlAction(CANCEL_MOVE_CODE);
    if (res.ok) {
      setCode(null);
      setStatus(null);
      router.refresh();
    }
    return res;
  }

  // The code is no use once a new Deplo has bound it.
  const shownCode = state === "armed" ? code : null;
  const cancellable =
    state === "armed" || state === "bound" || state === "copying";
  const canCreate =
    !incoming &&
    (state === null || state === "done" || (state === "armed" && !shownCode));

  return (
    <Card>
      <SettingItem
        icon={ArrowUpFromLine}
        title="Move this Deplo"
        info="Copies every team, app and setting to a fresh Deplo on another machine. This Deplo keeps running as it is."
        docs="deplo.move"
        description={
          <OutStatus
            status={status}
            hasCode={!!shownCode}
            incoming={incoming}
          />
        }
        control={
          (canCreate || cancellable) && (
            <>
              {canCreate && (
                <Button size="sm" onClick={create} disabled={creating}>
                  {creating && <Loader2 className="size-4 animate-spin" />}
                  {state === "done"
                    ? "Create move code again"
                    : "Create move code"}
                </Button>
              )}
              {cancellable && (
                <ConfirmAction
                  trigger={
                    <Button size="sm" variant="outline">
                      Cancel
                    </Button>
                  }
                  title={
                    state === "armed"
                      ? "Cancel the move code?"
                      : "Cancel the copy?"
                  }
                  description={
                    state === "armed"
                      ? "The move code stops working at once."
                      : "The new Deplo is cut off, and anything paused for the copy starts again here."
                  }
                  consequence={
                    state === "armed"
                      ? undefined
                      : "The copy stops where it is and has to start over with a new code."
                  }
                  confirmLabel={
                    state === "armed" ? "Cancel move code" : "Cancel copy"
                  }
                  successMessage={
                    state === "armed" ? "Move code cancelled" : "Copy cancelled"
                  }
                  onConfirm={cancel}
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
  const peer = status.peerUrl ? (
    <PeerLink url={status.peerUrl} />
  ) : (
    "another machine"
  );
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
      return <>Connected from {peer}. Start the copy there.</>;
    case "copying":
      return (
        <>
          Copying to {peer}. Apps with data pause briefly while theirs is
          copied.
        </>
      );
    case "done":
      return <>Copied to {peer}.</>;
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

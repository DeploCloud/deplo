"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { gql, gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepShell } from "@/components/settings/migrations/step-shell";
import type { TakeoverMode } from "@/components/settings/migrations/steps";

// https://deplo.build/docs/migrations

const STATUS = /* GraphQL */ `
  query TakeoverStatus {
    takeover {
      state
    }
  }
`;

const TAKE_PORTS = /* GraphQL */ `
  mutation RequestTakeover(
    $runId: String
    $noOtherTeams: Boolean
    $discardData: Boolean
    $acceptDataLoss: Boolean
  ) {
    requestTakeover(
      runId: $runId
      noOtherTeams: $noOtherTeams
      discardData: $discardData
      acceptDataLoss: $acceptDataLoss
    ) {
      state
    }
  }
`;

// Read again from the client: a copy that fails writes it while this page is open.
const DATA_LOSS = /* GraphQL */ `
  query TakeoverDataLoss {
    takeover {
      dataLoss
    }
  }
`;

const CANCEL = /* GraphQL */ `
  mutation CancelTakeover($apiKey: String) {
    cancelTakeover(apiKey: $apiKey) {
      restarted
      left
    }
  }
`;

export type TakeoverState =
  | "pending"
  | "ready"
  | "failed"
  | "done"
  | "removing"
  | "removed"
  | "cancelled";

const POLL_MS = 3000;
const SLOW_MS = 60_000;
const DEAD_MS = 90_000;
// Issuance follows a Docker restart and a Traefik restart: a measured Start clean
// took 80 s from `removed` to the certificate.
const CERT_GRACE_MS = 180_000;

// takeoverLandingUrl - where the browser lands once the machine is Deplo's.
export function takeoverLandingUrl(finalUrl: string, platformLabel: string) {
  return `${finalUrl}/?welcome=1&takeover=${encodeURIComponent(platformLabel)}`;
}

// TakeoverStep - one confirmation moves the ports and takes the other panel off the disk.
export function TakeoverStep({
  platformLabel,
  mode,
  state,
  error,
  finishedRunId,
  finalUrl,
  dataLoss = [],
}: {
  platformLabel: string;
  mode: TakeoverMode;
  state: Exclude<TakeoverState, "cancelled">;
  error: string | null;
  finishedRunId: string | null;
  finalUrl: string;
  dataLoss?: string[];
}) {
  if (state !== "pending" && state !== "failed")
    return (
      <TakeoverWaiting
        platformLabel={platformLabel}
        state={state}
        finalUrl={finalUrl}
      />
    );
  return (
    <TakeoverConfirm
      platformLabel={platformLabel}
      mode={mode}
      finishedRunId={finishedRunId}
      error={state === "failed" ? (error ?? "") : null}
      dataLoss={dataLoss}
    />
  );
}

function TakeoverConfirm({
  platformLabel,
  mode,
  finishedRunId,
  error,
  dataLoss,
}: {
  platformLabel: string;
  mode: TakeoverMode;
  finishedRunId: string | null;
  // Non-null when the last attempt rolled back: the card offers Try again instead.
  error: string | null;
  dataLoss: string[];
}) {
  const router = useRouter();
  const [retrying, setRetrying] = React.useState(false);
  const clean = mode === "clean";
  // A copy that fails after the server render is missing from it, and the takeover
  // was then refused with no way to accept the loss.
  const [loss, setLoss] = React.useState(dataLoss);
  const readLoss = () => {
    void gql<{ takeover: { dataLoss: string[] } | null }>(DATA_LOSS)
      .then((d) => setLoss(d.takeover?.dataLoss ?? []))
      // Keep what is known: the mutation refuses on the server's own list anyway.
      .catch(() => {});
  };
  const lossy = !clean && loss.length > 0;
  const [lossAccepted, setLossAccepted] = React.useState(false);
  // A token reads ONE team of that panel and it cannot always list the others, so
  // the operator states this: Deplo has no way to look it up.
  const [understood, setUnderstood] = React.useState(false);

  const args = (agreed: boolean) => ({
    runId: clean ? null : finishedRunId,
    noOtherTeams: clean ? null : agreed,
    discardData: clean,
    acceptDataLoss: lossy ? lossAccepted : null,
  });

  async function retry() {
    setRetrying(true);
    // The operator already ticked every box before the attempt that rolled back.
    const res = await gqlAction(TAKE_PORTS, {
      ...args(true),
      acceptDataLoss: clean ? null : true,
    });
    if (!res.ok) {
      setRetrying(false);
      toast.error(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <StepShell
      hero
      title={clean ? `Delete ${platformLabel}` : "Take over the machine"}
      lead={
        clean
          ? `Deplo takes ports 80 and 443, then ${platformLabel} and everything it runs here is deleted.`
          : `Deplo takes ports 80 and 443 from ${platformLabel}, inherits its certificates, and takes it off this machine for good.`
      }
    >
      {error !== null && (
        <div className="flex w-full items-start gap-2 rounded-lg border border-destructive/40 bg-destructive-wash-strong p-3 text-left text-sm leading-relaxed">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-medium">
              The ports were put back. {platformLabel} is running again.
            </p>
            {error && (
              <p className="mt-1 break-words text-muted-foreground">{error}</p>
            )}
          </div>
        </div>
      )}

      {/* The one thing left to do on this screen, so it sits under the middle of it. */}
      <div className="flex items-center justify-center gap-3">
        {error !== null ? (
          <Button onClick={retry} disabled={retrying}>
            {retrying && <Loader2 className="animate-spin" />}
            Try again
          </Button>
        ) : (
          <ConfirmAction
            trigger={
              <Button>
                {clean ? "Delete it and take over" : "Take over the machine"}
              </Button>
            }
            onOpenChange={(v) => {
              if (v) readLoss();
            }}
            title={
              clean
                ? `Delete ${platformLabel} from this machine?`
                : `Take the machine from ${platformLabel}?`
            }
            description={
              <>
                Deplo takes ports 80 and 443, then{" "}
                <strong>{platformLabel} comes off this machine</strong>.{" "}
                <DocsLink topic="migration.takeover" />
              </>
            }
            consequence={
              clean
                ? `Its apps, teams, networks, images and directory are deleted, and nothing comes across. Their volumes stay on the disk until you remove them yourself.`
                : `Its containers, networks, images and directory are deleted. The volumes those workloads held stay on the disk.`
            }
            extra={
              <div className="grid gap-2">
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-wash-strong p-3 text-sm leading-relaxed">
                  <Checkbox
                    checked={understood}
                    onCheckedChange={(v) => setUnderstood(v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      {clean
                        ? "I understand every app and all its data on this machine is destroyed"
                        : `I have no other teams on this ${platformLabel}`}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {clean
                        ? "Nothing was brought over, and nothing about it is kept anywhere."
                        : "One token reads one team. Anything not brought over yet stays on a panel that stops answering."}
                    </span>
                  </span>
                </label>
                {lossy && (
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive-wash-strong p-3 text-sm leading-relaxed">
                    <Checkbox
                      checked={lossAccepted}
                      onCheckedChange={(v) => setLossAccepted(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium">
                        {loss.length === 1
                          ? `${loss[0]} loses its data`
                          : `${loss.length} services lose their data: ${loss.join(", ")}`}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {`The copy failed, so ${platformLabel} still holds the only copy and it stops for good at the takeover.`}
                      </span>
                    </span>
                  </label>
                )}
              </div>
            }
            confirmDisabled={!understood || (lossy && !lossAccepted)}
            confirmText={platformLabel.toLowerCase()}
            confirmLabel={clean ? "Delete it" : "Take it over"}
            variant={clean ? "destructive" : "default"}
            successMessage="Moving the ports"
            optimistic
            onConfirm={async () => {
              const res = await gqlAction(TAKE_PORTS, args(understood));
              if (res.ok) router.refresh();
              // The copy may have failed between opening this and confirming it:
              // re-read so re-opening offers the box, not the same wall.
              else readLoss();
              return res;
            }}
          />
        )}
      </div>
    </StepShell>
  );
}

function onFinalOrigin(finalUrl: string): boolean {
  try {
    return window.location.origin === new URL(finalUrl).origin;
  } catch {
    return false;
  }
}

function TakeoverWaiting({
  platformLabel,
  state,
  finalUrl,
}: {
  platformLabel: string;
  state: Exclude<TakeoverState, "cancelled" | "pending" | "failed">;
  finalUrl: string;
}) {
  const router = useRouter();
  const [slow, setSlow] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    const started = Date.now();
    let removedAt: number | null = null;
    let deadSince: number | null = null;
    const id = setInterval(async () => {
      // A poll that fails is the ports moving, or Docker restarting, not an error.
      try {
        const d = await gql<{ takeover: { state: TakeoverState } | null }>(
          STATUS,
        );
        if (!live) return;
        deadSince = null;
        const s = d.takeover?.state;
        if (s === "removed") removedAt ??= Date.now();
        else if (s && s !== state) router.refresh();
      } catch {
        deadSince ??= Date.now();
      }
      if (!live) return;
      if (removedAt != null && onFinalOrigin(finalUrl)) {
        window.location.replace(takeoverLandingUrl(finalUrl, platformLabel));
        return;
      }
      // The removal restarts Docker, so a page that moved onto the final address
      // earlier died with it; and until the ports move the old panel answers that
      // address with a 404, which an opaque `no-cors` probe read as "it works".
      const since = removedAt ?? deadSince;
      const leave =
        since != null && (removedAt != null || Date.now() - since > DEAD_MS);
      if (leave && !onFinalOrigin(finalUrl)) {
        const target =
          removedAt != null
            ? takeoverLandingUrl(finalUrl, platformLabel)
            : `${finalUrl}/takeover`;
        const answers = await fetch(`${finalUrl}/api/health`, {
          cache: "no-store",
        })
          .then((r) => r.ok)
          // A certificate still being issued fails exactly like nothing listening,
          // so only a cutover KNOWN to have succeeded goes anyway: a silent origin
          // may be a rollback, whose Try again lives on this page.
          .catch(() => false);
        if (!live) return;
        if (
          answers ||
          (removedAt != null && Date.now() - since > CERT_GRACE_MS)
        )
          window.location.replace(target);
        return;
      }
      if (live && Date.now() - started > SLOW_MS) setSlow(true);
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [router, state, finalUrl, platformLabel]);

  if (state !== "ready")
    return (
      <Working
        title={`Removing ${platformLabel}`}
        body={`${platformLabel} and everything it ran are being removed from this machine. The dashboard opens by itself when it is gone.`}
      />
    );

  return (
    <Working
      title="Moving the ports"
      body={`${platformLabel} is being stopped and Deplo is taking its place on the web ports. This page follows the dashboard to its own address by itself.`}
    >
      {slow && (
        <SlowNote>
          Taking longer than usual? Open{" "}
          <a className="underline underline-offset-4" href={finalUrl}>
            {finalUrl}
          </a>{" "}
          yourself. The browser may warn once while the certificate is being
          issued.
        </SlowNote>
      )}
    </Working>
  );
}

// TakeoverCancel - backing out from any step, in one muted line under the wizard.
export function TakeoverCancel({
  platformLabel,
  tokenLabel,
}: {
  platformLabel: string;
  tokenLabel: string;
}) {
  const [cancelKey, setCancelKey] = React.useState("");
  const [cancelling, setCancelling] = React.useState(false);

  // Deplo is uninstalling itself: no page to go back to and nothing to poll.
  if (cancelling)
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background px-4">
        <div className="w-full max-w-xl">
          <Working
            spinner
            title="Taking Deplo back off this machine"
            body={`${platformLabel} keeps everything. Deplo is uninstalling itself now.`}
          />
        </div>
      </div>
    );

  return (
    <p className="text-center text-xs text-muted-foreground">
      Changed your mind?{" "}
      <ConfirmAction
        trigger={
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel and remove Deplo
          </Button>
        }
        title={`Remove Deplo and go back to ${platformLabel}?`}
        description={
          <>
            Deplo comes off this machine and your services start again.{" "}
            <strong>{platformLabel} keeps all of its data.</strong>
          </>
        }
        extra={
          <div className="grid gap-1.5">
            <Label htmlFor="cancel-key">
              {tokenLabel}, to start them again
            </Label>
            <Input
              id="cancel-key"
              type="password"
              autoComplete="off"
              value={cancelKey}
              onChange={(e) => setCancelKey(e.target.value)}
              placeholder={`Paste the ${tokenLabel}`}
            />
          </div>
        }
        confirmLabel="Remove Deplo"
        optimistic
        onConfirm={async () => {
          const res = await gqlAction<
            { cancelTakeover: { restarted: number; left: string[] } },
            { restarted: number; left: string[] }
          >(CANCEL, { apiKey: cancelKey || null }, (d) => d.cancelTakeover);
          if (res.ok) {
            setCancelling(true);
            const left = res.data?.left ?? [];
            if (left.length > 0)
              toast.warning(
                `Started ${res.data?.restarted ?? 0} again. These would not start: ${left.join("; ")}`,
              );
          }
          return res;
        }}
      />
    </p>
  );
}

function Working({
  title,
  body,
  spinner = false,
  children,
}: {
  title: string;
  body: React.ReactNode;
  spinner?: boolean;
  children?: React.ReactNode;
}) {
  return (
    // Three plain periods, never the ellipsis CHARACTER: the copy tests ban it.
    <StepShell hero title={`${title}...`} lead={body}>
      {spinner && (
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
      )}
      {children}
    </StepShell>
  );
}

function SlowNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-wash-strong p-3 text-left text-sm leading-relaxed text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

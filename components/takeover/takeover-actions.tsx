"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { gql, gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LeftoverDiskGraphic } from "@/components/takeover/leftover-disk-graphic";
import type { TakeoverMode } from "@/components/settings/migrations/steps";

// https://deplo.build/docs/guides/take-over-your-vps

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

/** How often the step re-asks while the host is doing something. */
const POLL_MS = 3000;
/** After this long without the final address answering, say how to get there. */
const SLOW_MS = 60_000;
/** How long this origin may stay silent before the final one is tried instead. */
const DEAD_MS = 90_000;
/** How long the final address gets to answer over https before it is opened anyway. */
const CERT_GRACE_MS = 45_000;

/** Where the browser lands once the machine is Deplo's: the home, celebrating. */
export function takeoverLandingUrl(finalUrl: string, platformLabel: string) {
  return `${finalUrl}/?welcome=1&takeover=${encodeURIComponent(platformLabel)}`;
}

/**
 * The wizard's last step. One confirmation moves the ports AND takes the other
 * panel off the disk, and the wait that follows stays right here - until the
 * dashboard answers on its own address, which is where this page then goes.
 */
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
  /** Whether anything was brought across, which is what the confirmation says. */
  mode: TakeoverMode;
  /** How far the handover has got. Anything but `pending` / `failed` is the host working. */
  state: Exclude<TakeoverState, "cancelled">;
  /** Why the last cutover rolled back, when `state` is `failed`. */
  error: string | null;
  /** The run that finished, on the path that had one. */
  finishedRunId: string | null;
  /** Where the dashboard answers once the ports have moved. */
  finalUrl: string;
  /** Services whose data did not come across: the old panel holds the only copy. */
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

/** The one decision, in the shape the rest of the app confirms a danger in. */
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
  /** Non-null when the last attempt rolled back: the card offers Try again instead. */
  error: string | null;
  dataLoss: string[];
}) {
  const router = useRouter();
  const [retrying, setRetrying] = React.useState(false);
  const clean = mode === "clean";
  /** The copy of these failed; the takeover stops the panel holding the only copy. */
  const lossy = !clean && dataLoss.length > 0;
  const [lossAccepted, setLossAccepted] = React.useState(false);
  /**
   * A token reads ONE team of that panel, and the panel cannot always list the
   * others - Coolify never can. The cutover stops it for good, so this is a thing
   * the operator says, not a thing Deplo can look up. On a clean takeover it is
   * instead the acknowledgement that all of it dies.
   */
  const [understood, setUnderstood] = React.useState(false);

  const args = (agreed: boolean) => ({
    runId: clean ? null : finishedRunId,
    noOtherTeams: clean ? null : agreed,
    discardData: clean,
    acceptDataLoss: lossy ? lossAccepted : null,
  });

  // The operator already confirmed once; the machine is back on the old panel
  // and the only question left is whether to try again.
  async function retry() {
    setRetrying(true);
    // The operator already ticked every box before the attempt that rolled back.
    const res = await gqlAction(TAKE_PORTS, {
      ...args(true),
      acceptDataLoss: lossy ? true : null,
    });
    if (!res.ok) {
      setRetrying(false);
      toast.error(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <LeftoverDiskGraphic className="mb-4 w-56" />
        <CardTitle>
          {clean ? `Delete ${platformLabel}` : "Take over the machine"}
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          {clean
            ? `Deplo takes ports 80 and 443, then ${platformLabel} and everything it runs here is deleted.`
            : `Deplo takes ports 80 and 443 from ${platformLabel}, inherits its certificates, and takes it off this machine for good.`}
        </p>
        {error !== null && (
          <div className="mt-4 flex w-full items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-left text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="font-medium">
                The ports were put back. {platformLabel} is running again.
              </p>
              {error && (
                <p className="mt-1 break-words text-muted-foreground">
                  {error}
                </p>
              )}
            </div>
          </div>
        )}
      </CardHeader>
      <CardFooter className="justify-end border-t border-border pt-6">
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
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
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
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
                    <Checkbox
                      checked={lossAccepted}
                      onCheckedChange={(v) => setLossAccepted(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium">
                        {dataLoss.length === 1
                          ? `${dataLoss[0]} loses its data`
                          : `${dataLoss.length} services lose their data: ${dataLoss.join(", ")}`}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {`The copy failed, so ${platformLabel} still holds the only copy and it stops for good at the takeover. Go back to Review and copy the data again instead.`}
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
              // The state is the server's, and it is what swaps this step's
              // body for the one that says the ports are moving.
              if (res.ok) router.refresh();
              return res;
            }}
          />
        )}
      </CardFooter>
    </Card>
  );
}

/** Whether this page is already served from the dashboard's own address. */
function onFinalOrigin(finalUrl: string): boolean {
  try {
    return window.location.origin === new URL(finalUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The step while the host works. Nothing here is clickable: the ports are moving
 * under it. The page follows them - onto the dashboard's own https address as
 * soon as it answers there, and onto the home once the old panel is gone.
 */
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
      // The state, from wherever this page is still served from. A poll that
      // fails is the ports moving, or Docker restarting, not an error to show.
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
      // This page leaves its origin ONLY once the old panel is gone - the removal
      // restarts Docker, and a page that moved onto the final address a moment
      // earlier died with it - or when nothing here answers any more. Then the
      // final address has to answer over its own https first: `no-cors` on
      // purpose, the only thing asked is whether the connection, certificate
      // included, works. A certificate that never comes stops nobody for long.
      const since = removedAt ?? deadSince;
      const leave =
        since != null && (removedAt != null || Date.now() - since > DEAD_MS);
      if (leave && !onFinalOrigin(finalUrl)) {
        const target =
          removedAt != null
            ? takeoverLandingUrl(finalUrl, platformLabel)
            : `${finalUrl}/takeover`;
        try {
          await fetch(`${finalUrl}/api/health`, {
            mode: "no-cors",
            cache: "no-store",
          });
          if (live) window.location.replace(target);
          return;
        } catch {
          if (live && Date.now() - since > CERT_GRACE_MS)
            window.location.replace(target);
          return;
        }
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
      body={
        <>
          {platformLabel} is being stopped and Deplo is taking its place on the
          web ports. This page follows the dashboard to its own address by
          itself.
          {slow && (
            <>
              <br />
              Taking longer than usual? Open{" "}
              <a className="underline underline-offset-4" href={finalUrl}>
                {finalUrl}
              </a>{" "}
              yourself. The browser may warn once while the certificate is being
              issued.
            </>
          )}
        </>
      }
    />
  );
}

/**
 * Backing out, in one muted line under the wizard: not a peer of the thing the
 * screen exists for, but reachable from every step - somebody who changes their
 * mind on step two should not have to finish first.
 */
export function TakeoverCancel({
  platformLabel,
  tokenLabel,
}: {
  platformLabel: string;
  /** Their word for it: Dokploy mints keys, Coolify tokens. */
  tokenLabel: string;
}) {
  const [cancelKey, setCancelKey] = React.useState("");
  const [cancelling, setCancelling] = React.useState(false);

  // Deplo is uninstalling itself, so there is no page to go back to and nothing
  // to poll: the last thing this origin does is say so.
  if (cancelling)
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background px-4">
        <div className="w-full max-w-xl">
          <Working
            title="Taking Deplo back off this machine"
            body={`${platformLabel} keeps everything. Deplo is uninstalling itself now.`}
          />
        </div>
      </div>
    );

  return (
    <p className="text-center text-sm text-muted-foreground">
      Changed your mind?{" "}
      <ConfirmAction
        trigger={
          <Button
            variant="link"
            className="h-auto p-0 text-sm text-destructive"
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

function Working({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          {title}
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </CardHeader>
    </Card>
  );
}

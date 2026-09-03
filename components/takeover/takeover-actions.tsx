"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { gql, gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LeftoverDiskGraphic } from "@/components/takeover/leftover-disk-graphic";
import type { TakeoverMode } from "@/components/settings/migrations/steps";

/**
 * The last step of the takeover: the machine changes hands. Everything it sets in
 * motion happens on the host, in the terminal window the installer is sitting in.
 */

const STATUS = /* GraphQL */ `
  query TakeoverStatus {
    takeover {
      state
      runId
      seenExternalRequest
    }
  }
`;

const TAKE_PORTS = /* GraphQL */ `
  mutation RequestTakeover(
    $runId: String
    $noOtherTeams: Boolean
    $discardData: Boolean
  ) {
    requestTakeover(
      runId: $runId
      noOtherTeams: $noOtherTeams
      discardData: $discardData
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
  "pending" | "ready" | "done" | "removing" | "removed" | "cancelled";

/** How often the step re-asks while the installer is doing something. */
const POLL_MS = 3000;

/**
 * The wizard's last step. One confirmation moves the ports AND takes the other
 * panel off the disk - landing on the dashboard has to mean this is Deplo and
 * nothing else - and the wait that follows stays right here, in the step.
 */
export function TakeoverStep({
  platformLabel,
  mode,
  state,
  finishedRunId,
  finalUrl,
}: {
  platformLabel: string;
  /** Whether anything was brought across, which is what the confirmation says. */
  mode: TakeoverMode;
  /** How far the handover has got. Anything but `pending` is the installer working. */
  state: Exclude<TakeoverState, "cancelled">;
  /** The run that finished, on the path that had one. */
  finishedRunId: string | null;
  /** Where the dashboard answers once the ports have moved. */
  finalUrl: string;
}) {
  if (state !== "pending")
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
    />
  );
}

/** The one decision, in the shape the rest of the app confirms a danger in. */
function TakeoverConfirm({
  platformLabel,
  mode,
  finishedRunId,
}: {
  platformLabel: string;
  mode: TakeoverMode;
  finishedRunId: string | null;
}) {
  const router = useRouter();
  const clean = mode === "clean";
  /**
   * A token reads ONE team of that panel, and the panel cannot always list the
   * others - Coolify never can. The cutover stops it for good, so this is a thing
   * the operator says, not a thing Deplo can look up. On a clean takeover it is
   * instead the acknowledgement that all of it dies.
   */
  const [understood, setUnderstood] = React.useState(false);

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <LeftoverDiskGraphic className="mb-4 w-56" />
        <CardTitle>
          {clean ? `Delete ${platformLabel}` : "Take over the machine"}
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          {clean
            ? `Deplo takes ports 80, 443 and 3000, then ${platformLabel} and everything it runs here is deleted.`
            : `Deplo takes ports 80, 443 and 3000 from ${platformLabel}, inherits its certificates, and takes it off this machine for good.`}
        </p>
      </CardHeader>
      <CardFooter className="justify-end border-t border-border pt-6">
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
            clean ? (
              <>
                {platformLabel} comes off this machine with everything on it:
                its apps, their data, their volumes and networks, its teams, its
                images and its directory. None of it can be brought back.
              </>
            ) : (
              <>
                Deplo takes the ports, then {platformLabel} comes off this
                machine: its containers, the workloads it ran, their volumes and
                networks, its images and its directory. None of it can be
                brought back.
              </>
            )
          }
          extra={
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
          }
          confirmDisabled={!understood}
          confirmText={platformLabel.toLowerCase()}
          confirmLabel={clean ? "Delete it" : "Take it over"}
          variant={clean ? "destructive" : "default"}
          successMessage="Moving the ports"
          optimistic
          onConfirm={async () => {
            const res = await gqlAction(TAKE_PORTS, {
              runId: clean ? null : finishedRunId,
              noOtherTeams: clean ? null : understood,
              discardData: clean,
            });
            // The state is the server's, and it is what swaps this step's body
            // for the one that says the ports are moving.
            if (res.ok) router.refresh();
            return res;
          }}
        />
      </CardFooter>
    </Card>
  );
}

/**
 * The step while the installer works. Nothing here is clickable: the ports are
 * moving under it, and this origin is about to stop answering.
 */
function TakeoverWaiting({
  platformLabel,
  state,
  finalUrl,
}: {
  platformLabel: string;
  state: Exclude<TakeoverState, "cancelled" | "pending">;
  finalUrl: string;
}) {
  const router = useRouter();

  // While the installer is working, the panel is the only thing that knows how
  // far it has got - and during the port move this page's own origin dies, so
  // the poll failing is expected rather than an error to show.
  React.useEffect(() => {
    let live = true;
    const id = setInterval(async () => {
      try {
        const d = await gql<{ takeover: { state: TakeoverState } | null }>(
          STATUS,
        );
        if (live && d.takeover && d.takeover.state !== state) router.refresh();
      } catch {
        /* the panel is restarting onto its own port - see finalUrl below */
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [router, state]);

  if (state !== "ready")
    return (
      <Working
        title={`Removing ${platformLabel}`}
        body="Its containers, volumes, networks, images, directory and swarm are being taken off this machine. The dashboard opens when it is gone."
      />
    );

  return (
    <Working
      title="Moving the ports"
      body={
        <>
          The installer is stopping {platformLabel}, inheriting its certificates
          and moving Deplo onto 80, 443 and 3000. This page stops answering
          while that happens.
          <br />
          Open{" "}
          <a className="underline underline-offset-4" href={finalUrl}>
            {finalUrl}
          </a>{" "}
          in a minute.
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
export function TakeoverCancel({ platformLabel }: { platformLabel: string }) {
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
            body={`${platformLabel} keeps everything. The installer is uninstalling Deplo now.`}
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
        title="Cancel the migration?"
        description={`Everything Deplo created here is removed, your services are started again on ${platformLabel}, and Deplo comes off this machine. ${platformLabel} keeps all of its data.`}
        extra={
          <div className="grid gap-1.5">
            <Label htmlFor="cancel-key">
              {platformLabel} API token, to start them again
            </Label>
            <Input
              id="cancel-key"
              type="password"
              autoComplete="off"
              value={cancelKey}
              onChange={(e) => setCancelKey(e.target.value)}
              placeholder="The same one you pasted before"
            />
          </div>
        }
        confirmLabel="Cancel it"
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

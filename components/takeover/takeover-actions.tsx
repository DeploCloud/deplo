"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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

/**
 * The three decisions a takeover asks a person for. Everything they set in motion
 * happens on the host, in the terminal window the installer is still sitting in.
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
  mutation RequestTakeover($runId: String!, $noOtherTeams: Boolean) {
    requestTakeover(runId: $runId, noOtherTeams: $noOtherTeams) {
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

/** How often the screen re-asks while the installer is doing something. */
const POLL_MS = 3000;

/**
 * The wizard's last step: the machine changes hands. One confirmation moves the
 * ports AND takes the other panel off the disk - landing on the dashboard has to
 * mean this is Deplo and nothing else.
 */
export function TakeoverStep({
  platformLabel,
  finishedRunId,
}: {
  platformLabel: string;
  /** The last run that finished. Without one there is nothing to take over for. */
  finishedRunId: string | null;
}) {
  const router = useRouter();
  /**
   * A token reads ONE team of that panel, and the panel cannot always list the
   * others - Coolify never can. The cutover stops it for good, so this is a
   * thing the operator says, not a thing Deplo can look up.
   */
  const [noOtherTeams, setNoOtherTeams] = React.useState(false);

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <LeftoverDiskGraphic className="mb-4 w-56" />
        <CardTitle>Take over the machine</CardTitle>
        <p className="text-sm text-muted-foreground">
          Deplo takes ports 80, 443 and 3000 from {platformLabel}, inherits its
          certificates, and takes it off this machine for good.
        </p>
      </CardHeader>
      <CardFooter className="justify-end gap-3 border-t border-border pt-6">
        {!finishedRunId && (
          <span className="mr-auto text-sm text-muted-foreground">
            Bring at least one project over first.
          </span>
        )}
        <ConfirmAction
          trigger={
            <Button disabled={!finishedRunId}>Take over the machine</Button>
          }
          title={`Take the machine from ${platformLabel}?`}
          description={
            <>
              Deplo takes the ports, then {platformLabel} comes off this
              machine: its containers, the workloads it ran, their volumes and
              networks, its images and its directory. None of it can be brought
              back.
            </>
          }
          extra={
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <Checkbox
                checked={noOtherTeams}
                onCheckedChange={(v) => setNoOtherTeams(v === true)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  I have no other teams on this {platformLabel}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  One token reads one team. Anything not brought over yet stays
                  on a panel that stops answering.
                </span>
              </span>
            </label>
          }
          confirmDisabled={!noOtherTeams}
          confirmText={platformLabel.toLowerCase()}
          confirmLabel="Take it over"
          variant="default"
          successMessage="Moving the ports"
          optimistic
          onConfirm={async () => {
            if (!finishedRunId) return { ok: false as const, error: "" };
            const res = await gqlAction(TAKE_PORTS, {
              runId: finishedRunId,
              noOtherTeams,
            });
            // The state is the server's, and it is what swaps this whole screen
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
 * The screen while the installer works. It takes the whole page on purpose: the
 * ports are moving under it, so there is nothing left to click and this origin is
 * about to stop answering.
 */
export function TakeoverWorking({
  platformLabel,
  state,
  finalUrl,
}: {
  platformLabel: string;
  state: Extract<TakeoverState, "ready" | "done" | "removing">;
  /** Where the dashboard answers once the ports have moved. */
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

"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { gql, gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  mutation RequestTakeover($runId: String!) {
    requestTakeover(runId: $runId) {
      state
    }
  }
`;

const REMOVE = /* GraphQL */ `
  mutation RequestPlatformRemoval {
    requestPlatformRemoval {
      state
    }
  }
`;

/** The same scan the wizard runs. A service still `new` after the migration is
 *  one that did not come across, which is exactly what the removal destroys. */
const LEFTOVERS = /* GraphQL */ `
  mutation TakeoverLeftovers(
    $url: String!
    $apiKey: String!
    $kind: MigrationPlatform
  ) {
    scanMigrationSource(input: { url: $url, apiKey: $apiKey, kind: $kind }) {
      projects {
        name
        environments {
          services {
            name
            status
          }
        }
      }
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

export function TakeoverActions({
  platformLabel,
  platform,
  sourceUrl,
  state: initialState,
  finishedRunId,
  finalUrl,
}: {
  platformLabel: string;
  platform: "dokploy" | "coolify";
  /** Where that panel answers on this machine, for the leftovers check. */
  sourceUrl: string;
  state: TakeoverState;
  /** The last run that finished. Without one there is nothing to take over for. */
  finishedRunId: string | null;
  /** Where the dashboard answers once the ports have moved. */
  finalUrl: string;
}) {
  const [state, setState] = React.useState<TakeoverState>(initialState);
  const [busy, setBusy] = React.useState(false);
  const [cancelKey, setCancelKey] = React.useState("");
  const [removeKey, setRemoveKey] = React.useState("");
  const [leftovers, setLeftovers] = React.useState<string[] | null>(null);

  async function checkLeftovers() {
    setBusy(true);
    const res = await gqlAction<
      {
        scanMigrationSource: {
          projects: {
            name: string;
            environments: { services: { name: string; status: string }[] }[];
          }[];
        };
      },
      string[]
    >(LEFTOVERS, { url: sourceUrl, apiKey: removeKey, kind: platform }, (d) =>
      d.scanMigrationSource.projects.flatMap((p) =>
        p.environments.flatMap((e) =>
          e.services
            .filter((sv) => sv.status === "new")
            .map((sv) => `${p.name} / ${sv.name}`),
        ),
      ),
    );
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setLeftovers(res.data ?? []);
  }

  // While the installer is working, the panel is the only thing that knows how
  // far it has got - and during the port move this page's own origin dies, so
  // the poll failing is expected rather than an error to show.
  const watching = state === "ready" || state === "removing";
  React.useEffect(() => {
    if (!watching) return;
    let live = true;
    const id = setInterval(async () => {
      try {
        const d = await gql<{ takeover: { state: TakeoverState } | null }>(
          STATUS,
        );
        if (live && d.takeover) setState(d.takeover.state);
      } catch {
        /* the panel is restarting onto its own port - see finalUrl below */
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [watching]);

  async function takePorts() {
    if (!finishedRunId) return;
    setBusy(true);
    const res = await gqlAction(TAKE_PORTS, { runId: finishedRunId });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setState("ready");
  }

  if (state === "ready")
    return (
      <Working
        title="Moving the ports"
        body={
          <>
            The installer is stopping {platformLabel}, inheriting its
            certificates and moving Deplo onto 80, 443 and 3000. This page stops
            answering while that happens.
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

  if (state === "removing")
    return (
      <Working
        title={`Removing ${platformLabel}`}
        body={`Its containers, volumes, networks, images and directory are being taken off this machine.`}
      />
    );

  if (state === "done")
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-success" />
            The ports are Deplo&apos;s
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {platformLabel} is stopped but still on the disk, volumes and all.
            Deploy your apps and check them before you remove it.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="remove-key">
              {platformLabel} API token, to list what stays behind
            </Label>
            <div className="flex gap-2">
              <Input
                id="remove-key"
                type="password"
                autoComplete="off"
                value={removeKey}
                onChange={(e) => {
                  setRemoveKey(e.target.value);
                  setLeftovers(null);
                }}
                placeholder="The same one you pasted before"
              />
              <Button
                variant="outline"
                onClick={checkLeftovers}
                disabled={!removeKey || busy}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Check
              </Button>
            </div>
          </div>

          {leftovers !== null && <Leftovers names={leftovers} />}

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/">Go to the dashboard</Link>
            </Button>
            <ConfirmAction
              trigger={
                <Button variant="destructive">Remove {platformLabel}</Button>
              }
              title={`Remove ${platformLabel}?`}
              description={
                <>
                  Its containers, the workloads it ran, their volumes and
                  networks, its images and its directory all come off this
                  machine. None of it can be brought back.
                </>
              }
              extra={
                leftovers !== null ? <Leftovers names={leftovers} /> : null
              }
              confirmText={platformLabel.toLowerCase()}
              confirmLabel="Remove it"
              successMessage={`Removing ${platformLabel}`}
              optimistic
              onConfirm={async () => {
                const res = await gqlAction(REMOVE);
                if (res.ok) setState("removing");
                return res;
              }}
            />
          </div>
        </CardContent>
      </Card>
    );

  if (state === "cancelled")
    return (
      <Working
        title="Taking Deplo back off this machine"
        body={`${platformLabel} keeps everything. The installer is uninstalling Deplo now.`}
      />
    );

  // pending: the migration is still the operator's to finish.
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Take over the machine</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            When everything you want is here, Deplo takes ports 80, 443 and 3000
            from {platformLabel} and inherits its certificates.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button onClick={takePorts} disabled={!finishedRunId || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Take over the ports
          </Button>
          {!finishedRunId && (
            <span className="text-sm text-muted-foreground">
              Bring at least one project over first.
            </span>
          )}
        </CardContent>
      </Card>

      {/* Outside the card, in one muted line: backing out is not a peer of the
          thing the screen exists for. The token it needs is in the dialog. */}
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
              setState("cancelled");
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
    </>
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

/** What never came across, and is about to go with the platform that holds it. */
function Leftovers({ names }: { names: string[] }) {
  if (names.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Everything came across. Nothing is left behind.
      </p>
    );
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/[0.06] p-3">
      <p className="text-sm font-medium">
        {names.length} {names.length === 1 ? "service was" : "services were"}{" "}
        not brought across, and will be destroyed:
      </p>
      <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
        {names.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

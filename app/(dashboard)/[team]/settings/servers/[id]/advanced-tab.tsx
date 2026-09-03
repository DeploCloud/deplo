"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  Check,
  Clock,
  Hammer,
  Cpu,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { CommandLine } from "@/components/shared/code-block";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { TimezonePicker } from "@/components/servers/timezone-picker";
import {
  ServerRoleOptions,
  type ServerRole,
} from "@/components/servers/server-role-options";
import { BetaChip } from "@/components/shared/beta-chip";
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
import type { ServerSummary } from "./server-detail-tabs";

/**
 * The Advanced tab: what this box actually IS, what time it thinks it is, and
 * the two irreversible things.
 */

type HostInfo = {
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  memTotalBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  osPretty: string;
  kernel: string;
  arch: string;
  dockerVersion: string;
  dockerRootDir: string;
  uptimeSec: number;
  timezone: string;
  timeUnixMs: number;
  controlPlaneTimeUnixMs: number;
  utcOffsetMinutes: number;
  canRestartControlPlane: boolean;
};

const HOST_INFO_FIELDS = `
  cpuModel cpuCores cpuThreads memTotalBytes diskTotalBytes diskUsedBytes
  osPretty kernel arch dockerVersion dockerRootDir uptimeSec
  timezone timeUnixMs controlPlaneTimeUnixMs utcOffsetMinutes
  canRestartControlPlane
`;

/**
 * A host reading, paired with the local instant it arrived.
 */
type Reading = { info: HostInfo; readAt: number };

export function ServerAdvancedTab({ server }: { server: ServerSummary }) {
  const [reading, setReading] = React.useState<Reading | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const info = reading?.info ?? null;

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await gqlAction<{ checkServerHostInfo: HostInfo }>(
      `mutation CheckServerHostInfo($id: String!) {
        checkServerHostInfo(id: $id) { ${HOST_INFO_FIELDS} }
      }`,
      { id: server.id },
    );
    setLoading(false);
    if (!res.ok) {
      // Includes "the agent on this server is too old for host management",
      // which is the actionable one - surfaced verbatim, not reworded.
      setError(res.error);
      setReading(null);
      return;
    }
    if (res.data)
      setReading({ info: res.data.checkServerHostInfo, readAt: Date.now() });
  }, [server.id]);

  React.useEffect(() => {
    // Opening the tab IS the read - it synchronises with an external system (the
    // owning server's agent) and `load` manages its own state. Same shape, and
    // the same scoped exemption, as the readiness dialog's probe-on-open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <>
      <ServerRolePanel server={server} />
      <HostDetails info={info} loading={loading} error={error} onRetry={load} />
      <ServerClock server={server} reading={reading} onChanged={setReading} />
      <InstallCommand server={server} />
      <DangerZone server={server} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Host details                                                        */
/* ------------------------------------------------------------------ */

function Detail({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-sm">{value}</span>
    </div>
  );
}

function HostDetails({
  info,
  loading,
  error,
  onRetry,
}: {
  info: HostInfo | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4" />
            Host details
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            What this machine is running, read from the server just now.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRetry} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {loading && !info ? (
          <div className="space-y-2">
            {/* A skeleton, not a spinner - the shape of what is coming. */}
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-muted/50" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : info ? (
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <Detail
                label="Processor"
                value={
                  info.cpuModel
                    ? `${info.cpuCores} core${info.cpuCores === 1 ? "" : "s"} · ${info.cpuModel}`
                    : `${info.cpuCores} core${info.cpuCores === 1 ? "" : "s"}`
                }
              />
              <Detail
                label="Threads"
                value={info.cpuThreads > 0 ? String(info.cpuThreads) : "—"}
              />
              <Detail label="Memory" value={formatBytes(info.memTotalBytes)} />
              <Detail
                label="Disk"
                value={`${formatBytes(info.diskUsedBytes)} of ${formatBytes(info.diskTotalBytes)} used`}
              />
              <Detail label="Uptime" value={formatUptime(info.uptimeSec)} />
            </div>
            <div>
              <Detail label="Operating system" value={info.osPretty || "—"} />
              <Detail label="Kernel" value={info.kernel || "—"} />
              <Detail label="Architecture" value={info.arch || "—"} />
              <Detail label="Docker" value={info.dockerVersion || "—"} />
              <Detail
                label={
                  <span className="flex items-center gap-1">
                    Docker data
                    <InfoTip
                      content="Where images and volumes are stored. On a server with a separate data disk this is not the main filesystem."
                      docs="servers.advanced"
                    />
                  </span>
                }
                value={info.dockerRootDir || "—"}
              />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatUptime(sec: number): string {
  if (sec <= 0) return "—";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/* ------------------------------------------------------------------ */
/* Server time                                                         */
/* ------------------------------------------------------------------ */

function ServerClock({
  server,
  reading,
  onChanged,
}: {
  server: ServerSummary;
  reading: Reading | null;
  onChanged: (reading: Reading) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [zone, setZone] = React.useState("");
  const info = reading?.info ?? null;

  // `nowMs` is written only by the interval below, never during render, and never
  // from an effect body.
  const [nowMs, setNowMs] = React.useState(0);

  // Adopt the host's zone into the field when a fresh reading lands. Adjusting state
  // during render is the supported pattern (cleanup-panel.tsx does the same with a
  // saved policy); an effect would render the old zone first.
  const [seen, setSeen] = React.useState(reading);
  if (seen !== reading) {
    const theirs = zone !== "" && zone !== seen?.info.timezone;
    setSeen(reading);
    if (reading?.info.timezone && !theirs) setZone(reading.info.timezone);
  }

  React.useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Before the first tick, show the reading as it arrived rather than "—": the
  // clock is correct at readAt, it simply has not advanced yet.
  const hostNow = reading
    ? new Date(reading.info.timeUnixMs + Math.max(0, nowMs - reading.readAt))
    : null;

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction<{ setServerTimezone: HostInfo }>(
        `mutation SetServerTimezone($id: String!, $timezone: String!) {
          setServerTimezone(id: $id, timezone: $timezone) { ${HOST_INFO_FIELDS} }
        }`,
        { id: server.id, timezone: zone },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // The mutation answers with a fresh reading, so the clock jumps to the new
      // zone without a second round trip.
      if (res.data)
        onChanged({ info: res.data.setServerTimezone, readAt: Date.now() });
      toast.success(`Server time is now ${zone}`);
    });
  }

  // How far the host's clock is from DEPLO's, both stamped server-side around the
  // same agent call. Never against the browser: that measures the browser, and a
  // laptop an hour out would paint every healthy server in the fleet red.
  const skewMs = info ? info.timeUnixMs - info.controlPlaneTimeUnixMs : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4" />
          Server time
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          The clock this machine runs on. Deplo&apos;s own schedules stay on
          UTC.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save}>
          {/* The clock itself: big, live, and in the SERVER's zone, so a host
              whose clock is wrong shows its wrong time rather than the browser's
              right one. */}
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            {hostNow && info ? (
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1 font-mono tabular-nums">
                    <span className="text-4xl leading-none font-semibold">
                      {partsIn(hostNow, info, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {/* Seconds come from the instant itself: every current IANA
                        offset is a whole number of minutes, and asking Intl for
                        seconds alone yields an unpadded "7". */}
                    <span className="text-xl leading-none text-muted-foreground">
                      :{String(hostNow.getUTCSeconds()).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {partsIn(hostNow, info, {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="muted" className="gap-1">
                    <Globe className="size-3" />
                    {info.timezone || "Unknown zone"}
                  </Badge>
                  <Badge variant="muted" className="font-mono">
                    {formatOffset(info.utcOffsetMinutes)}
                  </Badge>
                  <SkewChip skewMs={skewMs} />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="h-9 w-40 animate-pulse rounded bg-muted/60" />
                <div className="h-4 w-56 animate-pulse rounded bg-muted/50" />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <FieldLabel
              htmlFor="server-timezone"
              info="The zone this machine reports its own time in. Nothing restarts, and nothing in Deplo moves with it: backups and cleanup run on UTC, and each container keeps the zone from its image."
              docs="servers.advanced"
            >
              Timezone
            </FieldLabel>
            <TimezonePicker
              id="server-timezone"
              value={zone}
              onChange={setZone}
              disabled={pending || !info}
              now={hostNow ? hostNow.getTime() : nowMs}
            />
          </div>
          <Button
            type="submit"
            disabled={pending || !info || !zone || zone === info?.timezone}
          >
            Save timezone
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * How far this host's clock is from DEPLO's, said plainly. Deplo's and not the
 * viewer's: the browser is a third machine with a clock of its own, and comparing
 * against it would report the viewer's laptop as the fleet drifting.
 */
function SkewChip({ skewMs }: { skewMs: number }) {
  const abs = Math.abs(skewMs);
  if (abs < 5_000)
    return (
      <Badge variant="muted" className="gap-1">
        <Check className="size-3" />
        In sync
      </Badge>
    );
  const amount =
    abs < 90_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 5_400_000
        ? `${Math.round(abs / 60_000)}m`
        : `${Math.round(abs / 3_600_000)}h`;
  const label = `${amount} ${skewMs > 0 ? "ahead of" : "behind"} Deplo`;
  return abs >= 60_000 ? (
    <SimpleTooltip content="A clock this far out breaks certificate renewal and two-factor codes. Check this server's time sync.">
      <span className="inline-flex">
        <Badge variant="destructive" className="gap-1">
          <TriangleAlert className="size-3" />
          {label}
        </Badge>
      </span>
    </SimpleTooltip>
  ) : (
    <Badge variant="muted">{label}</Badge>
  );
}

/**
 * One `Intl` read of an instant in the HOST's zone.
 */
function partsIn(
  at: Date,
  info: Pick<HostInfo, "timezone" | "utcOffsetMinutes">,
  opts: Intl.DateTimeFormatOptions,
): string {
  if (info.timezone) {
    try {
      return at.toLocaleString("en-GB", { timeZone: info.timezone, ...opts });
    } catch {
      // An IANA name this browser does not carry; fall through to the offset.
    }
  }
  const shifted = new Date(at.getTime() + info.utcOffsetMinutes * 60_000);
  return shifted.toLocaleString("en-GB", { timeZone: "UTC", ...opts });
}

/** "+01:00" / "-03:30" - minutes, because Kathmandu is +05:45. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Install command                                                     */
/* ------------------------------------------------------------------ */

function InstallCommand({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [command, setCommand] = React.useState<string | null>(null);

  function reissue() {
    startTransition(async () => {
      const res = await gqlAction<{
        reissueServerBootstrap: { installCommand: string };
      }>(
        `mutation ReissueServerBootstrap($id: String!) {
          reissueServerBootstrap(id: $id) { installCommand }
        }`,
        { id: server.id },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.data) setCommand(res.data.reissueServerBootstrap.installCommand);
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            Install command
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {server.provisioning
              ? "This server is still waiting for its agent. Run the command on the box to finish setting it up."
              : "Mint a fresh one-time setup command, for reinstalling the agent on this box."}
          </p>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => reissue()}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {server.provisioning
              ? "Show install command"
              : "Reissue install command"}
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={command !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCommand(null);
            router.refresh();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install command for {server.name}</DialogTitle>
            <DialogDescription>
              Run this once on the server. It installs Docker (if needed) and
              the Deplo agent, which then calls home to finish provisioning.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Install command (shown once)</Label>
            {command ? <CommandLine command={command} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              The command embeds a single-use token that expires in about an
              hour. If you lose it, reissue another from here.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setCommand(null);
                router.refresh();
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Danger zone                                                         */
/* ------------------------------------------------------------------ */

/**
 * The address edit (the migration verb: the host got a new IP, or the whole
 * instance moved).
 */
function ChangeAddress({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState(server.host);
  const [port, setPort] = React.useState(
    server.agentPort ? String(server.agentPort) : "",
  );
  const [refusal, setRefusal] = React.useState<string | null>(null);

  function openDialog() {
    setAddress(server.host);
    setPort(server.agentPort ? String(server.agentPort) : "");
    setRefusal(null);
    setOpen(true);
  }

  function save(force: boolean) {
    startTransition(async () => {
      const res = await gqlAction<{ updateServerAddress: string | null }>(
        `mutation ChangeServerAddress($id: String!, $address: String!, $agentPort: Int, $force: Boolean) {
          updateServerAddress(id: $id, address: $address, agentPort: $agentPort, force: $force)
        }`,
        {
          id: server.id,
          address: address.trim(),
          agentPort: port.trim() ? Number(port.trim()) : null,
          force,
        },
      );
      if (!res.ok) {
        // Shown inline (verbatim) where the "Save anyway" escape sits next to it.
        setRefusal(res.error);
        return;
      }
      setOpen(false);
      toast.success("Server address updated");
      if (res.data?.updateServerAddress)
        toast.warning(res.data.updateServerAddress);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            Change address
            <BetaChip />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Where Deplo reaches this server&rsquo;s agent. Change it when the
            host got a new IP or you moved it.
          </p>
        </div>
        <Button variant="outline" onClick={openDialog} disabled={pending}>
          <Globe className="size-4" />
          Change address
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Change address for {server.name}?</DialogTitle>
              <DialogDescription>
                Deplo checks that the agent answers at the new address before
                saving. Apps and databases on the server are not touched.
              </DialogDescription>
            </DialogHeader>
            {server.isDeploHost && (
              <p className="text-sm text-destructive">
                This server runs Deplo itself - a wrong address here cuts this
                dashboard off from its own host.
              </p>
            )}
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="server-address"
                info="IP or DNS name. App URLs follow it immediately; custom domains keep pointing at the old address until you update their DNS records."
                docs="servers.address"
              >
                Address
              </FieldLabel>
              <Input
                id="server-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="203.0.113.7 or server.example.com"
                autoFocus
              />
            </div>
            {server.agentPort !== null && (
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="server-agent-port"
                  info="The port the Deplo agent listens on (default 9443). Change it only if you moved the agent."
                  docs="servers.address"
                >
                  Agent port
                </FieldLabel>
                <Input
                  id="server-agent-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>
            )}
            {refusal && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <p>{refusal}</p>
                <p className="mt-1 text-muted-foreground">
                  Save anyway if the host is not up at the new address yet -
                  Deplo keeps checking its health there.
                </p>
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              {refusal && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => save(true)}
                  disabled={pending || !address.trim()}
                >
                  {pending ? "Saving" : "Save anyway"}
                </Button>
              )}
              <Button type="submit" disabled={pending || !address.trim()}>
                {pending ? "Saving" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DangerZone({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirm, setConfirm] = React.useState(false);
  const [uninstall, setUninstall] = React.useState<string | null>(null);

  function remove() {
    startTransition(async () => {
      const res = await gqlAction<{
        removeServer: { uninstallCommand: string; warning: string | null };
      }>(
        `mutation RemoveServer($id: String!) {
          removeServer(id: $id) { uninstallCommand warning }
        }`,
        { id: server.id },
      );
      if (!res.ok) {
        // Surfaces "move or delete the apps on this server first" verbatim.
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      setConfirm(false);
      toast.success(`${server.name} removed - now clean up the host`);
      if (res.data.removeServer.warning)
        toast.warning(res.data.removeServer.warning);
      setUninstall(res.data.removeServer.uninstallCommand);
    });
  }

  return (
    <>
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-4 text-destructive" />
            Danger zone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ChangeAddress server={server} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">Remove this server</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {server.isDeploHost
                  ? "This server runs Deplo itself, so it cannot be removed - doing so would cut this dashboard off from its own server."
                  : "Deplo stops trusting this server and forgets it. Nothing on the host is uninstalled; you get the command for that."}
              </p>
            </div>
            {/* Disabled rather than hidden on the Deplo host: an operator looking
                for this needs to know it exists and why it is refused. The data
                layer refuses it too - this is the explanation, not the guard. */}
            <SimpleTooltip
              content={
                server.isDeploHost
                  ? "The host running Deplo cannot be removed"
                  : "Revoke this agent's trust and forget the server"
              }
              side="left"
            >
              <span>
                <Button
                  variant="destructive"
                  onClick={() => setConfirm(true)}
                  disabled={pending || server.isDeploHost}
                >
                  <Trash2 className="size-4" />
                  Remove server
                </Button>
              </span>
            </SimpleTooltip>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {server.name}?</DialogTitle>
            <DialogDescription>
              This revokes the agent&rsquo;s trust and forgets the server.{" "}
              <strong>It does not uninstall anything on the host</strong> - the
              Deplo agent, Traefik on :80/:443 and the <code>Deplo</code>{" "}
              network all keep running there. We&rsquo;ll give you the command
              to remove them as soon as it&rsquo;s gone. You can&rsquo;t remove
              a server while apps or databases still live on it - move or delete
              those first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove()}
              disabled={pending}
            >
              {pending ? "Removing" : "Remove server"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The server is gone from Deplo; its agent is still running on the host.
          This is the only thing that can actually remove it. */}
      <Dialog
        open={uninstall !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUninstall(null);
            router.push("/settings/servers");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finish the cleanup on {server.name}</DialogTitle>
            <DialogDescription>
              Deplo no longer trusts this server, but its agent is still
              installed and running there. Run this on the host, as root, to
              remove it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Uninstall command</Label>
            {uninstall ? <CommandLine command={uninstall} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Removes the deplo-agent service and binary,{" "}
              <code>/var/lib/deplo-agent</code> (its certificates and
              Traefik&rsquo;s issued TLS certs), the <code>deplo-traefik</code>{" "}
              container and the <code>Deplo</code> Docker network. It leaves
              Docker itself alone, and it does <strong>not</strong> delete your
              data - app and database volumes, built images and{" "}
              <code>/data</code> survive. Add <code>--purge-data</code> to
              delete those too; that is irreversible.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setUninstall(null);
                router.push("/settings/servers");
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * What a server is FOR: it runs apps, or it only builds for the ones that do, or
 * it only holds backups.
 */
function ServerRolePanel({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [role, setRole] = React.useState(server.role);

  // A backups-only install has no Docker to become anything else with. `dockerVersion`
  // is only ever non-empty because an agent reported one, so it is the honest signal.
  const stuckOnStorage = server.role === "storage" && !server.dockerVersion;

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction<{ setServerRole: { id: string } }>(
        `mutation SetServerRole($id: String!, $role: String!) {
          setServerRole(id: $id, role: $role) { id }
        }`,
        { id: server.id, role },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        role === "build"
          ? `${server.name} now only builds`
          : role === "storage"
            ? `${server.name} now only holds backups`
            : `${server.name} runs apps again`,
      );
      router.refresh();
    });
  }

  // Saying "move them off first" only helps ahead of the refusal, so it is shown
  // while the choice is still unsaved - not after the server has said no.
  const needsEmptying = role !== "everything" && server.role === "everything";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hammer className="size-4" />
          What this server is for
          <BetaChip />
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          A build server compiles images for apps that run on your other
          servers, so those can stay small.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save}>
          <ServerRoleOptions
            value={role}
            onChange={setRole}
            // A host installed without Docker can only hold backups.
            disabled={(r: ServerRole) =>
              r === "storage" ? pending : pending || stuckOnStorage
            }
          />
          {stuckOnStorage && (
            <Badge variant="warning">
              This server was installed without Docker, so it can only hold
              backups. Re-run the install command on the host to change that.
            </Badge>
          )}
          {needsEmptying && (
            <Badge variant="warning">
              Apps and databases have to be moved off this server first.
            </Badge>
          )}
          {role === "everything" && server.role === "build" && (
            <Badge variant="warning">
              This server has no proxy installed, so apps deployed here will run
              but stay unreachable on their domains. Re-run the install command
              on the host to add one.
            </Badge>
          )}
          <div>
            <Button type="submit" disabled={pending || role === server.role}>
              {pending ? "Saving" : "Save"}
            </Button>
          </div>
        </form>
        {server.role !== "storage" && <BuildFallbackRow server={server} />}
      </CardContent>
    </Card>
  );
}

/**
 * Whether this host takes over a build when the app's own build server cannot be
 * reached. On for the Deplo host until someone says otherwise.
 */
function BuildFallbackRow({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [on, setOn] = React.useState(server.buildFallback);

  function toggle(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation SetServerBuildFallback($id: String!, $buildFallback: Boolean) {
          setServerBuildFallback(id: $id, buildFallback: $buildFallback) { id }
        }`,
        { id: server.id, buildFallback: next },
      );
      if (!res.ok) {
        setOn(server.buildFallback);
        toast.error(res.error);
        return;
      }
      toast.success(
        next
          ? `${server.name} will build as a fallback`
          : `${server.name} will not build as a fallback`,
      );
      router.refresh();
    });
  }

  return (
    <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          Build as a fallback
          <InfoTip
            content={
              <>
                When an app&apos;s build server cannot be reached, this host
                compiles for it instead. Only apps whose own server has the same
                CPU architecture.
              </>
            }
            docs="build.serversHowItWorks"
          />
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {on
            ? "Compiles for apps whose own build server is down."
            : "Never asked to build for another server's apps."}
        </p>
      </div>
      <Switch
        checked={on}
        onCheckedChange={toggle}
        disabled={pending}
        aria-label="Build as a fallback"
      />
    </div>
  );
}

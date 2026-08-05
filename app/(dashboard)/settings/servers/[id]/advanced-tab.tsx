"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Clock,
  Cpu,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  LayoutDashboard,
} from "lucide-react";

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
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
import type { ServerSummary } from "./server-detail-tabs";

/**
 * The Advanced tab: what this box actually IS, what time it thinks it is, the
 * Traefik web panel, and the two irreversible things.
 *
 * Host details are fetched when the tab is opened, never during the page render:
 * this is the page you reach for when a server is misbehaving, and it must not be
 * as slow as the server it is describing.
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
  utcOffsetMinutes: number;
  traefikManaged: boolean;
  traefikDashboardDomain: string | null;
  canRestartControlPlane: boolean;
};

const HOST_INFO_FIELDS = `
  cpuModel cpuCores cpuThreads memTotalBytes diskTotalBytes diskUsedBytes
  osPretty kernel arch dockerVersion dockerRootDir uptimeSec
  timezone timeUnixMs utcOffsetMinutes
  traefikManaged traefikDashboardDomain canRestartControlPlane
`;

/**
 * A host reading, paired with the local instant it arrived. The pair is what
 * lets the clock below tick from the SERVER's time rather than the browser's,
 * and keeping `readAt` next to the reading means neither the render nor an
 * effect ever has to ask what time it is.
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
      // which is the actionable one — surfaced verbatim, not reworded.
      setError(res.error);
      setReading(null);
      return;
    }
    if (res.data) setReading({ info: res.data.checkServerHostInfo, readAt: Date.now() });
  }, [server.id]);

  React.useEffect(() => {
    // Opening the tab IS the read — it synchronises with an external system (the
    // owning server's agent) and `load` manages its own state. Same shape, and
    // the same scoped exemption, as the readiness dialog's probe-on-open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <>
      <HostDetails info={info} loading={loading} error={error} onRetry={load} />
      <ServerClock server={server} reading={reading} onChanged={setReading} />
      <TraefikPanel server={server} info={info} onChanged={load} />
      <InstallCommand server={server} />
      <DangerZone server={server} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Host details                                                        */
/* ------------------------------------------------------------------ */

function Detail({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
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
            {/* A skeleton, not a spinner — the shape of what is coming. */}
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
                    <InfoTip content="Where images and volumes are stored. On a server with a separate data disk this is not the main filesystem." />
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

/** The canonical IANA zones, from the browser's own database — no list to ship
 *  and no dependency. The data layer accepts aliases too, so a zone missing here
 *  is still settable through the API. */
function allTimezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

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
  const zones = React.useMemo(() => allTimezones(), []);
  const info = reading?.info ?? null;

  // `nowMs` is written only by the interval below — never during render, and
  // never from an effect body. Combined with the reading's own `readAt`, the
  // displayed time is a pure function of state: the SERVER's clock advanced by
  // however long ago we read it, so a box whose clock is wrong shows its wrong
  // time rather than the browser's right one. That is the whole point of it.
  const [nowMs, setNowMs] = React.useState(0);

  // Adopt the host's zone into the field when a fresh reading lands. Adjusting
  // state during render is the supported pattern (cleanup-panel.tsx does the
  // same with a saved policy); an effect would render the old zone first.
  const [seen, setSeen] = React.useState(reading);
  if (seen !== reading) {
    setSeen(reading);
    if (reading?.info.timezone) setZone(reading.info.timezone);
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
      if (res.data) onChanged({ info: res.data.setServerTimezone, readAt: Date.now() });
      toast.success(`Server time is now ${zone}`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4" />
          Server time
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          The clock this server runs on. Scheduled jobs and log timestamps follow it.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save}>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground">Current server time</div>
            <div className="mt-1 font-mono text-lg tabular-nums">
              {hostNow && info
                ? `${hostNow.toLocaleString("en-GB", {
                    timeZone: info.timezone || "UTC",
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })} ${formatOffset(info.utcOffsetMinutes)}`
                : "—"}
            </div>
          </div>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="server-timezone"
              info="Pick the region you operate in. Changing it does not restart anything, but log timestamps and schedules shift to the new zone."
            >
              Timezone
            </FieldLabel>
            {/* A datalist rather than a 400-item select: typing "Rome" beats
                scrolling, and it still accepts a zone the list does not carry. */}
            <Input
              id="server-timezone"
              list="deplo-timezones"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Europe/Rome"
              disabled={pending || !info}
              className="max-w-sm"
            />
            <datalist id="deplo-timezones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          <Button type="submit" disabled={pending || !info || !zone || zone === info?.timezone}>
            {pending ? "Saving" : "Save timezone"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** "+01:00" / "-03:30" — minutes, because Kathmandu is +05:45. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Traefik web panel                                                   */
/* ------------------------------------------------------------------ */

function TraefikPanel({
  server,
  info,
  onChanged,
}: {
  server: ServerSummary;
  info: HostInfo | null;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(Boolean(server.traefikDashboard));
  const [domain, setDomain] = React.useState(server.traefikDashboard?.domain ?? "");
  const [username, setUsername] = React.useState(server.traefikDashboard?.username ?? "");
  const [password, setPassword] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);

  const alreadyPublished = Boolean(server.traefikDashboard);
  // A password is required to publish, but an EDIT that only moves the domain
  // reuses the stored one — asking for it again would be a reason not to bother.
  const complete =
    domain.trim() !== "" && username.trim() !== "" && (password !== "" || alreadyPublished);
  const canManage = info?.traefikManaged ?? false;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!enabled) {
      apply();
      return;
    }
    if (!complete) return;
    // Applying recreates the Traefik container, which takes every site on this
    // host down for a few seconds. That is not something to discover afterwards.
    setConfirming(true);
  }

  function apply() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation SetServerTraefikDashboard($id: String!, $input: TraefikDashboardInput) {
          setServerTraefikDashboard(id: $id, input: $input) { id }
        }`,
        {
          id: server.id,
          input: enabled
            ? { domain: domain.trim(), username: username.trim(), password: password || null }
            : null,
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConfirming(false);
      setPassword("");
      toast.success(
        enabled ? `Traefik panel published on ${domain.trim()}` : "Traefik panel turned off",
      );
      onChanged();
      router.refresh();
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LayoutDashboard className="size-4" />
            Traefik web panel
            <InfoTip content="Traefik's own dashboard: the live view of every route and certificate on this server. Useful when a domain is not resolving the way you expect." />
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Publish Traefik&rsquo;s dashboard on a domain of yours, behind a
            username and password.
          </p>
        </CardHeader>
        <CardContent>
          {info && !canManage ? (
            <p className="text-sm text-muted-foreground">
              This server runs a reverse proxy Deplo did not install, so Deplo
              will not reconfigure it here.
            </p>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              <div className="flex items-center gap-3">
                <Switch
                  id="traefik-panel"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={pending || !info}
                />
                <Label htmlFor="traefik-panel">Publish the panel</Label>
              </div>

              {enabled ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <FieldLabel
                      htmlFor="traefik-domain"
                      info="Point this domain's DNS at this server first, or the certificate cannot be issued."
                    >
                      Domain
                    </FieldLabel>
                    <Input
                      id="traefik-domain"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="traefik.example.com"
                      disabled={pending}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel
                      htmlFor="traefik-user"
                      info="Anyone with these credentials can see every route and certificate on this server."
                    >
                      Username
                    </FieldLabel>
                    <Input
                      id="traefik-user"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="off"
                      disabled={pending}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel
                      htmlFor="traefik-password"
                      info="Stored encrypted and never shown again. Leave blank when editing to keep the current one."
                    >
                      Password
                    </FieldLabel>
                    <Input
                      id="traefik-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={alreadyPublished ? "Unchanged" : ""}
                      autoComplete="new-password"
                      disabled={pending}
                      required={!alreadyPublished}
                    />
                  </div>
                </div>
              ) : null}

              <Button type="submit" disabled={pending || !info || (enabled && !complete)}>
                {pending ? "Applying" : enabled ? "Publish panel" : "Turn off panel"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish the Traefik panel on {domain.trim()}?</DialogTitle>
            <DialogDescription>
              Traefik has to restart to pick this up, so every site on{" "}
              {server.name} is unreachable for a few seconds. Make sure{" "}
              <strong>{domain.trim()}</strong> already points at this server, or
              its certificate will not be issued.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => apply()} disabled={pending}>
              {pending ? "Applying" : "Publish panel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
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
      const res = await gqlAction<{ reissueServerBootstrap: { installCommand: string } }>(
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
          <Button variant="outline" onClick={() => reissue()} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {server.provisioning ? "Show install command" : "Reissue install command"}
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
              Run this once on the server. It installs Docker (if needed) and the
              Deplo agent, which then calls home to finish provisioning.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Install command (shown once)</Label>
            {command ? <CommandLine command={command} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              The command embeds a single-use token that expires in about an hour.
              If you lose it, reissue another from here.
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
      toast.success(`${server.name} removed — now clean up the host`);
      if (res.data.removeServer.warning) toast.warning(res.data.removeServer.warning);
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
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Remove this server</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {server.isDeploHost
                  ? "This server runs Deplo itself, so it cannot be removed — doing so would cut this dashboard off from its own server."
                  : "Deplo stops trusting this server and forgets it. Nothing on the host is uninstalled; you get the command for that."}
              </p>
            </div>
            {/* Disabled rather than hidden on the Deplo host: an operator looking
                for this needs to know it exists and why it is refused. The data
                layer refuses it too — this is the explanation, not the guard. */}
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
              <strong>It does not uninstall anything on the host</strong> — the
              Deplo agent, Traefik on :80/:443 and the <code>deplo</code> network
              all keep running there. We&rsquo;ll give you the command to remove
              them as soon as it&rsquo;s gone. You can&rsquo;t remove a server
              while apps or databases still live on it — move or delete those
              first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove()} disabled={pending}>
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
              Deplo no longer trusts this server, but its agent is still installed
              and running there. Run this on the host, as root, to remove it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Uninstall command</Label>
            {uninstall ? <CommandLine command={uninstall} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Removes the deplo-agent service and binary,{" "}
              <code>/var/lib/deplo-agent</code> (its certificates and
              Traefik&rsquo;s issued TLS certs), the <code>deplo-traefik</code>{" "}
              container and the <code>deplo</code> Docker network. It leaves
              Docker itself alone, and it does <strong>not</strong> delete your
              data — app and database volumes, built images and <code>/data</code>{" "}
              survive. Add <code>--purge-data</code> to delete those too; that is
              irreversible.
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

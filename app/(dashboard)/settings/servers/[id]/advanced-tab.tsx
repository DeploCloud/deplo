"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Archive,
  Check,
  Clock,
  Hammer,
  Cpu,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Sparkles,
  Trash2,
  TriangleAlert,
  LayoutDashboard,
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
import { AccessOption } from "@/components/servers/server-team-access";
import { BetaChip } from "@/components/shared/beta-chip";
import { gqlAction } from "@/lib/graphql-client";
import { regenerateNipDomain } from "@/lib/nip-suggestion";
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
  controlPlaneTimeUnixMs: number;
  utcOffsetMinutes: number;
  traefikManaged: boolean;
  traefikDashboardDomain: string | null;
  canRestartControlPlane: boolean;
};

const HOST_INFO_FIELDS = `
  cpuModel cpuCores cpuThreads memTotalBytes diskTotalBytes diskUsedBytes
  osPretty kernel arch dockerVersion dockerRootDir uptimeSec
  timezone timeUnixMs controlPlaneTimeUnixMs utcOffsetMinutes
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
      <ServerRolePanel server={server} />
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

  // `nowMs` is written only by the interval below — never during render, and
  // never from an effect body. Combined with the reading's own `readAt`, the
  // displayed time is a pure function of state: the SERVER's clock advanced by
  // however long ago we read it, so a box whose clock is wrong shows its wrong
  // time rather than the browser's right one. That is the whole point of it.
  const [nowMs, setNowMs] = React.useState(0);

  // Adopt the host's zone into the field when a fresh reading lands. Adjusting
  // state during render is the supported pattern (cleanup-panel.tsx does the
  // same with a saved policy); an effect would render the old zone first.
  //
  // Unless the operator has an unsaved pick of their own: Refresh sits next to
  // this card and re-reads the host, and throwing away a zone someone just chose
  // is not what pressing Refresh means.
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
      if (res.data) onChanged({ info: res.data.setServerTimezone, readAt: Date.now() });
      toast.success(`Server time is now ${zone}`);
    });
  }

  // How far the host's clock is from DEPLO's, both stamped server-side around the
  // same agent call. Never against the browser: that measures the browser, and a
  // laptop an hour out would paint every healthy server in the fleet red. It is
  // the one number a wall clock cannot show you, and it is what explains a
  // certificate that will not issue or a cron that fires late.
  const skewMs = info ? info.timeUnixMs - info.controlPlaneTimeUnixMs : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4" />
          Server time
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          The clock this machine runs on. Deplo&apos;s own schedules stay on UTC.
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
                    <span className="text-4xl font-semibold leading-none">
                      {partsIn(hostNow, info, { hour: "2-digit", minute: "2-digit" })}
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
          <Button type="submit" disabled={pending || !info || !zone || zone === info?.timezone}>
            {pending ? "Saving" : "Save timezone"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * How far this host's clock is from DEPLO's, said plainly.
 *
 * Deplo's and not the viewer's: the browser is a third machine with a clock of
 * its own, and comparing against it would report the viewer's laptop as the
 * fleet drifting. Under five seconds is noise (the agent round trip is inside
 * this number), so it reads as in sync. Past a minute it is the destructive one:
 * a clock that far out breaks certificate issuance and TOTP before it breaks
 * anything visible.
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
 * One `Intl` read of an instant in the HOST's zone. The pieces of the clock are
 * formatted separately so the seconds can be styled apart from the rest.
 *
 * A host can report an offset but no zone NAME (a copied /etc/localtime with no
 * /etc/timezone beside it: Alpine, slim images). Falling back to UTC there
 * printed a clock two hours off the offset badge right next to it, so the
 * fallback shifts the instant by the offset the host DID report and reads it as
 * UTC: same wall time, no zone database needed. Every current IANA offset is a
 * whole number of minutes, so the seconds are unaffected by the shift.
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
  const [domain, setDomain] = React.useState(
    server.traefikDashboard?.domain ?? server.suggestedTraefikDomain ?? "",
  );
  const [username, setUsername] = React.useState(server.traefikDashboard?.username ?? "");
  const [password, setPassword] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  // Set once we have applied something ourselves: from then on the stored row and
  // the host cannot disagree, so the drift line below stays out of the way while
  // the page and the reading catch up with each other.
  const [applied, setApplied] = React.useState(false);

  // What the HOST is publishing, read off its own Traefik configuration. Our
  // stored row is only what we last wrote, and the two can disagree — so the
  // switch, the button and the link below all follow the host, and the row is
  // reduced to what it can actually answer for (the username). Before the first
  // reading lands there is nothing else to go on, so the row stands in.
  const published = info ? info.traefikDashboardDomain : (server.traefikDashboard?.domain ?? null);
  const recorded = server.traefikDashboard?.domain ?? null;
  const canManage = info?.traefikManaged ?? false;
  // The free hostname currently on offer. Seeded with the server's own (already
  // fresh) suggestion and re-rolled in the browser on every Generate, so the
  // tooltip always names the one the button would drop into the field.
  const [suggested, setSuggested] = React.useState(server.suggestedTraefikDomain);

  // Adopt the host's answer whenever a fresh reading arrives. Adjusting state
  // during render is the supported pattern (ServerClock above does the same with
  // the timezone); an effect would paint the stale value first.
  const [seen, setSeen] = React.useState(info);
  if (seen !== info) {
    setSeen(info);
    if (info) {
      setEnabled(info.traefikDashboardDomain !== null);
      if (info.traefikDashboardDomain) setDomain(info.traefikDashboardDomain);
    }
  }

  // A password is required to publish, but an EDIT that only moves the domain
  // reuses the stored one — asking for it again would be a reason not to bother.
  const complete =
    domain.trim() !== "" && username.trim() !== "" && (password !== "" || published !== null);
  // What Apply would actually change. Without this the button is armed on a host
  // with no panel, reading "Turn off panel" and recreating Traefik — every site
  // here blipping — to turn off something that was never on.
  const changes = enabled
    ? domain.trim().toLowerCase() !== (published ?? "") ||
      username.trim() !== (server.traefikDashboard?.username ?? "") ||
      password !== ""
    : published !== null;
  // Named for what it will do to THIS host, not for the switch's position: with
  // nothing published, "Turn off panel" describes nothing that exists.
  const actionLabel = !enabled ? "Turn off panel" : published ? "Update panel" : "Publish panel";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!changes || (enabled && !complete)) return;
    // Either direction recreates the Traefik container, which takes every site on
    // this host down for a few seconds. That is not something to discover
    // afterwards, so both get the same confirmation.
    setConfirming(true);
  }

  function apply() {
    const next = domain.trim().toLowerCase();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation SetServerTraefikDashboard($id: String!, $input: TraefikDashboardInput) {
          setServerTraefikDashboard(id: $id, input: $input) { id }
        }`,
        {
          id: server.id,
          input: enabled
            ? { domain: next, username: username.trim(), password: password || null }
            : null,
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConfirming(false);
      setPassword("");
      setApplied(true);
      toast.success(enabled ? `Traefik panel published on ${next}` : "Traefik panel turned off");
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
            <BetaChip />
            <InfoTip content="Traefik's own dashboard: the live view of every route and certificate on this server. Useful when a domain is not resolving the way you expect." />
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Publish Traefik&rsquo;s dashboard on a domain, behind a username and
            password.
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
              {/* Where it is answering right now, with the way in. A published
                  panel with no link to it is a domain you have to remember. Shown
                  only once the HOST has answered: the stored row is old news, and
                  "live" is a claim only a reading can make. */}
              {info && published ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Live on this server</div>
                    <p className="mt-1 truncate font-mono text-sm text-muted-foreground">
                      {published}
                    </p>
                  </div>
                  <Button variant="outline" asChild>
                    <a href={`https://${published}`} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-4" />
                      Open panel
                    </a>
                  </Button>
                </div>
              ) : null}

              {/* Our record and the host disagree — said out loud, because the
                  only way here is someone having reconfigured the proxy on the
                  box. Nothing is repaired silently, and the host is believed. */}
              {info && !applied && recorded && recorded !== published ? (
                <p className="text-sm text-muted-foreground">
                  {published
                    ? `Deplo had ${recorded} on record for this server, so its proxy was reconfigured somewhere else.`
                    : `Deplo had this panel on record for ${recorded}, but the host is not publishing it.`}
                </p>
              ) : null}

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
                    {/* Same shape as the Add domain dialog: the free hostname is
                        offered here too, because a fresh install has no domain to
                        point at this and the panel would be unreachable. */}
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel
                        htmlFor="traefik-domain"
                        info={
                          suggested ? (
                            <>
                              No domain? <span className="font-mono">{suggested}</span>{" "}
                              is filled in for you and works with zero DNS setup.
                              Click Generate for a different one.
                            </>
                          ) : (
                            "Point this domain's DNS at this server first, or the certificate cannot be issued."
                          )
                        }
                      >
                        Domain
                      </FieldLabel>
                      {/* Rolls new words onto the same server, endlessly, and is
                          also the way back after typing over the field. */}
                      {suggested ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground"
                          onClick={() => {
                            const next = regenerateNipDomain(suggested);
                            setSuggested(next);
                            setDomain(next);
                          }}
                          disabled={pending}
                        >
                          <Sparkles className="size-3.5" />
                          Generate
                        </Button>
                      ) : null}
                    </div>
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
                      placeholder={published ? "Unchanged" : ""}
                      autoComplete="new-password"
                      disabled={pending}
                      required={published === null}
                    />
                  </div>
                </div>
              ) : null}

              <Button
                type="submit"
                disabled={pending || !info || !changes || (enabled && !complete)}
              >
                {pending ? "Applying" : actionLabel}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            {enabled ? (
              <>
                <DialogTitle>Publish the Traefik panel on {domain.trim().toLowerCase()}?</DialogTitle>
                <DialogDescription>
                  Traefik has to restart to pick this up, so every site on{" "}
                  {server.name} is unreachable for a few seconds.{" "}
                  {domain.trim().toLowerCase() === suggested ? (
                    <>
                      This hostname already resolves to this server, so its
                      certificate can be issued right away.
                    </>
                  ) : (
                    <>
                      Make sure <strong>{domain.trim().toLowerCase()}</strong>{" "}
                      already points at this server, or its certificate will not be
                      issued.
                    </>
                  )}
                </DialogDescription>
              </>
            ) : (
              <>
                <DialogTitle>Turn the Traefik panel off on {server.name}?</DialogTitle>
                <DialogDescription>
                  It stops answering on <strong>{published}</strong>. Traefik has
                  to restart for that, so every site on this server is unreachable
                  for a few seconds.
                </DialogDescription>
              </>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => apply()} disabled={pending}>
              {pending ? "Applying" : actionLabel}
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

/**
 * The address edit (the migration verb: the host got a new IP, or the whole
 * instance moved). Verify-first: the mutation refuses when the agent does not
 * answer at the new address, and only that refusal reveals "Save anyway" - the
 * escape for a host that is not up there yet. Trust is the pinned certificate,
 * not the address, so a typo is always recoverable by editing again.
 */
function ChangeAddress({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState(server.host);
  const [port, setPort] = React.useState(server.agentPort ? String(server.agentPort) : "");
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
      if (res.data?.updateServerAddress) toast.warning(res.data.updateServerAddress);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Change address</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Where Deplo reaches this server&rsquo;s agent. Change it when the host
            got a new IP or you moved it.
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
                  Save anyway if the host is not up at the new address yet - Deplo
                  keeps checking its health there.
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
        <CardContent className="space-y-4">
          <ChangeAddress server={server} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
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

/**
 * What a server is FOR: it runs apps, or it only builds for the ones that do, or
 * it only holds backups.
 *
 * ADVANCED, because it is a fleet-shaping decision nobody makes on their first
 * day, and because the default ("Everything") is what almost every server is.
 *
 * The three are not symmetric in one direction only. Any host that HAS Docker can
 * take any role - the role is a control-plane decision, and the installer's only
 * per-role difference is whether it sets Traefik up. But a server INSTALLED as
 * backups-only never had Docker put on it, and no database write can change that,
 * so it cannot leave that role until the install command is re-run on the host.
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
          A build server compiles images for apps that run on your other servers,
          so those can stay small.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save}>
          <div className="grid gap-2 sm:grid-cols-3">
            <AccessOption
              icon={ServerCog}
              title="Everything"
              description="Runs apps and builds them"
              selected={role === "everything"}
              disabled={pending || stuckOnStorage}
              onSelect={() => setRole("everything")}
            />
            <AccessOption
              icon={Hammer}
              title="Only build"
              description="Builds for other servers"
              selected={role === "build"}
              disabled={pending || stuckOnStorage}
              onSelect={() => setRole("build")}
              badge={<BetaChip />}
            />
            <AccessOption
              icon={Archive}
              title="Only backups"
              description="Holds backup files"
              selected={role === "storage"}
              disabled={pending}
              onSelect={() => setRole("storage")}
            />
          </div>
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
              but stay unreachable on their domains. Re-run the install command on
              the host to add one.
            </Badge>
          )}
          <div>
            <Button type="submit" disabled={pending || role === server.role}>
              {pending ? "Saving" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

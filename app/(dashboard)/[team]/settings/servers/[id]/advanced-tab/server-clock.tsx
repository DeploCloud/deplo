"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Clock, Globe, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { TimezonePicker } from "@/components/servers/timezone-picker";
import { HostUnavailable } from "@/components/servers/host-unavailable";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";
import { HOST_INFO_FIELDS, type HostInfo, type Reading } from "./host-info";

// ServerClock shows the host's live clock and sets its timezone.
export function ServerClock({
  server,
  reading,
  error,
  onChanged,
}: {
  server: ServerSummary;
  reading: Reading | null;
  error: string | null;
  onChanged: (reading: Reading) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [zone, setZone] = React.useState("");
  const info = reading?.info ?? null;

  const [nowMs, setNowMs] = React.useState(0);

  // Adjusting state during render is the supported pattern here; an effect would
  // render the old zone first.
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

  // Before the first tick, show the reading as it arrived rather than "—".
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
      if (res.data)
        onChanged({ info: res.data.setServerTimezone, readAt: Date.now() });
      toast.success(`Server time is now ${zone}`);
    });
  }

  // Both stamps are taken server-side around the same agent call. Never against the
  // browser: a laptop an hour out would paint every healthy server in the fleet red.
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
        {error && !info ? (
          <HostUnavailable what="Server time" reason={error} />
        ) : (
          <form className="space-y-4" onSubmit={save}>
            {/* In the SERVER's zone, so a host whose clock is wrong shows its
              wrong time rather than the browser's right one. */}
            <div className="rounded-lg border border-border bg-surface p-4">
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
                  <div className="h-9 w-40 animate-pulse rounded bg-surface-strong" />
                  <div className="h-4 w-56 animate-pulse rounded bg-surface-strong" />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <FieldLabel
                htmlFor="server-timezone"
                info="The zone this machine reports its own time in. Nothing in Deplo moves with it: backups and cleanup run on UTC."
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
        )}
      </CardContent>
    </Card>
  );
}

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

// Minutes, not hours, because Kathmandu is +05:45.
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

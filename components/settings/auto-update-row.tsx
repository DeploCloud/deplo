"use client";

import * as React from "react";
import { toast } from "sonner";
import { Clock, MoreHorizontal, PauseCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Bone } from "@/components/ui/skeleton";
import { TimezonePicker } from "@/components/servers/timezone-picker";
import { gqlAction } from "@/lib/graphql-client";
import { describeAt, slotHours } from "@/lib/auto-updates/window";
import type { AutoUpdateStatus } from "@/lib/data/auto-updates";

export type { AutoUpdateStatus };

const SET = /* GraphQL */ `
  mutation SetAutoUpdates($enabled: Boolean, $hour: Int, $timezone: String) {
    setAutoUpdates(enabled: $enabled, hour: $hour, timezone: $timezone) {
      current
    }
  }
`;

const pad = (n: number) => `${String(n).padStart(2, "0")}:00`;

const when = (iso: string, tz: string, now: Date) => {
  const at = describeAt(new Date(iso), now, tz);
  return at.startsWith("at ") ? `today ${at}` : at;
};

export function autoUpdateLine(
  s: AutoUpdateStatus,
  next: string | null,
  now: Date,
): string {
  if (s.blockedBy === "provider")
    return "Whoever runs this install manages Deplo's updates.";
  if (s.blockedBy === "canary")
    return "Canary versions install only when you click Update.";
  if (s.blockedBy === "host")
    return "Deplo can't update itself on this machine.";
  if (!s.enabled) return "Off. New versions install when you click Update.";
  if (next && s.heldReason) return `${next} has to be installed by hand.`;
  if (next && s.installsAt) {
    const line = `${next} installs itself ${when(s.installsAt, s.timezone, now)} (${s.timezone}).`;
    if (!s.postponedBy) return line;
    const times = s.postponedTimes === 1 ? "once" : `${s.postponedTimes} times`;
    return `${line} Postponed ${times}, last by ${s.postponedBy}.`;
  }
  if (s.nextCheckAt)
    return `Next check ${when(s.nextCheckAt, s.timezone, now)} (${s.timezone}).`;
  return "On.";
}

const ROW =
  "flex flex-col gap-3 border-t border-border p-5 sm:flex-row sm:items-center sm:justify-between";

function RowTitle() {
  return (
    <p className="flex items-center gap-1.5 text-sm font-medium">
      <Clock className="size-4 shrink-0 text-muted-foreground" />
      <label htmlFor="auto-updates">Automatic updates</label>
      <InfoTip
        content="New stable versions install themselves at night, at the first of three checks where nothing is deploying or backing up."
        docs="upgrade.automatic"
      />
    </p>
  );
}

export function AutoUpdateRowSkeleton() {
  return (
    <div className={ROW}>
      <div className="min-w-0 flex-1">
        <RowTitle />
        <p className="mt-1 text-sm text-muted-foreground">
          <Bone>Next check today at 03:00 (Europe/Rome).</Bone>
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Bone box>
          <Switch checked={false} disabled aria-hidden />
        </Bone>
      </div>
    </div>
  );
}

export function AutoUpdateRow({
  status,
  next,
  onChanged,
}: {
  status: AutoUpdateStatus;
  next: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [editing, setEditing] = React.useState(false);
  const adopted = React.useRef(false);
  const blocked = status.blockedBy !== null;

  // The machine only says UTC: the admin's own browser knows better.
  React.useEffect(() => {
    if (status.timezoneSource !== "default" || adopted.current) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || /^(etc\/)?(utc|gmt)/i.test(tz)) return;
    adopted.current = true;
    void gqlAction(
      /* GraphQL */ `
        mutation AdoptAutoUpdateTimezone($timezone: String!) {
          adoptAutoUpdateTimezone(timezone: $timezone) {
            current
          }
        }
      `,
      { timezone: tz },
    ).then((res) => {
      if (res.ok) void onChanged();
    });
  }, [status.timezoneSource, onChanged]);

  function toggle(on: boolean) {
    startTransition(async () => {
      const res = await gqlAction(SET, { enabled: on });
      if (!res.ok) return void toast.error(res.error);
      toast.success(
        on ? "Automatic updates turned on" : "Automatic updates turned off",
      );
      await onChanged();
    });
  }

  function postpone() {
    startTransition(async () => {
      const res = await gqlAction(/* GraphQL */ `
        mutation PostponeAutoUpdate {
          postponeAutoUpdate {
            current
          }
        }
      `);
      if (!res.ok) return void toast.error(res.error);
      toast.success("Postponed by one night");
      await onChanged();
    });
  }

  const canPostpone = Boolean(
    next && status.installsAt && status.enabled && !blocked,
  );

  return (
    <div className={ROW}>
      <div className="min-w-0 flex-1">
        <RowTitle />
        <p className="mt-1 text-sm text-muted-foreground">
          {autoUpdateLine(status, next, new Date())}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Switch
          id="auto-updates"
          checked={status.enabled && !blocked}
          disabled={blocked || pending}
          onCheckedChange={toggle}
        />
        {!blocked && status.enabled && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-1 text-muted-foreground hover:text-foreground"
                aria-label="Automatic updates options"
                disabled={pending}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {canPostpone && (
                <DropdownMenuItem onSelect={postpone}>
                  <PauseCircle className="size-4" />
                  Postpone one night
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Clock className="size-4" />
                Change schedule
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ScheduleDialog
        open={editing}
        onOpenChange={setEditing}
        status={status}
        onSaved={onChanged}
      />
    </div>
  );
}

function ScheduleDialog({
  open,
  onOpenChange,
  status,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: AutoUpdateStatus;
  onSaved: () => Promise<void> | void;
}) {
  const [hour, setHour] = React.useState(status.hour);
  const [timezone, setTimezone] = React.useState(status.timezone);
  const [now, setNow] = React.useState(0);
  const [saving, startSaving] = React.useTransition();

  function reset(o: boolean) {
    if (o) {
      setHour(status.hour);
      setTimezone(status.timezone);
      setNow(Date.now());
    }
    onOpenChange(o);
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    startSaving(async () => {
      const res = await gqlAction(SET, {
        hour,
        ...(timezone !== status.timezone ? { timezone } : {}),
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Automatic updates moved");
      onOpenChange(false);
      await onSaved();
    });
  }

  const [first, , last] = slotHours(hour);
  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>When Deplo updates itself</DialogTitle>
          <DialogDescription>
            Deplo checks <strong>three times, an hour apart</strong>, and
            installs at the first check where nothing is running.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={save}>
          <div className="space-y-4">
            <div className="space-y-2">
              <FieldLabel
                htmlFor="auto-update-hour"
                info={`Checks at ${pad(first)}, ${pad((first + 1) % 24)} and ${pad(last)}.`}
              >
                First check
              </FieldLabel>
              <Select
                value={String(hour)}
                onValueChange={(v) => setHour(Number(v))}
              >
                <SelectTrigger id="auto-update-hour">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>
                      {pad(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <FieldLabel
                htmlFor="auto-update-timezone"
                info="Starts as the timezone of the machine Deplo runs on."
              >
                Timezone
              </FieldLabel>
              <TimezonePicker
                id="auto-update-timezone"
                value={timezone}
                onChange={setTimezone}
                now={now}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

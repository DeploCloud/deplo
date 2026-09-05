"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { AnimatedHeight } from "@/components/shared/animated-height";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SchedulePicker } from "@/components/shared/schedule-picker";
import { TimezonePicker } from "@/components/servers/timezone-picker";
import { dstSkipWarning } from "@/lib/crons/cron-tz";
import { gqlAction } from "@/lib/graphql-client";
import type { CronJobDTO } from "@/lib/data/crons";

/**
 * Create or edit one cron job. Name, target, schedule and command are the form;
 * anything with a defensible default is under Advanced. Two things are said out
 * loud: timeout x retries (the server refuses the product) and the DST hour.
 */

const SERVICE_INHERIT = "__default__";

const CREATE = /* GraphQL */ `
  mutation ($targetKind: String!, $targetId: ID!, $input: CronJobInput!) {
    createCronJob(targetKind: $targetKind, targetId: $targetId, input: $input) {
      id
    }
  }
`;

const UPDATE = /* GraphQL */ `
  mutation ($id: ID!, $input: CronJobInput!) {
    updateCronJob(id: $id, input: $input) {
      id
    }
  }
`;

interface EnvRow {
  key: string;
  value: string;
}

/** The browser's own zone, which is almost always what the author means. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function CronJobDialog({
  open,
  onOpenChange,
  targetKind,
  targetId,
  services,
  job,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  targetKind: "app" | "database";
  targetId: string;
  /** Compose services a job can run in. Empty for a database (one container). */
  services: string[];
  /** Where a job that picks no container runs - named in the picker. */
  primaryService?: string | null;
  /** Absent ⇒ create. */
  job?: CronJobDTO;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Read once, lazily: the timezone list shows a live clock per zone, and
  // reading `Date.now()` during render would be impure (and re-read on every
  // keystroke). A minute's drift in a picker nobody keeps open costs nothing.
  const [pickerNow] = React.useState(() => Date.now());

  // Seeded at MOUNT, not in an effect: the caller mounts this component only
  // while the dialog is open, so mounting IS opening - and a lazy initializer
  // cannot be fought by a prop mid-typing the way a sync effect can.
  const [name, setName] = React.useState(job?.name ?? "");
  const [description, setDescription] = React.useState(job?.description ?? "");
  const [service, setService] = React.useState(job?.service ?? SERVICE_INHERIT);
  const [schedule, setSchedule] = React.useState(job?.schedule ?? "0 3 * * *");
  const [timezone, setTimezone] = React.useState(
    () => job?.timezone ?? browserZone(),
  );
  const [shell, setShell] = React.useState<string>(job?.shell ?? "sh");
  const [command, setCommand] = React.useState(job?.command ?? "");
  const [enabled, setEnabled] = React.useState(job?.enabled ?? true);
  const [timeoutMinutes, setTimeoutMinutes] = React.useState(
    String(Math.round((job?.timeoutSeconds ?? 3600) / 60)),
  );
  const [maxAttempts, setMaxAttempts] = React.useState(
    String(job?.maxAttempts ?? 1),
  );
  const [overlap, setOverlap] = React.useState<string>(job?.overlap ?? "skip");
  const [keepRuns, setKeepRuns] = React.useState(String(job?.keepRuns ?? 50));
  const [workdir, setWorkdir] = React.useState(job?.workdir ?? "");
  const [user, setUser] = React.useState(job?.user ?? "");
  const [env, setEnv] = React.useState<EnvRow[]>(() =>
    (job?.envKeys ?? []).map((key) => ({ key, value: "" })),
  );
  /** Editing keeps the stored variables unless the author touches them: their
   *  values are unreadable, so sending the list back would blank every secret. */
  const [envTouched, setEnvTouched] = React.useState(false);
  /** A stored key sent back blank means "keep it" - the server carries the value over. */
  const storedKeys = React.useMemo(() => new Set(job?.envKeys ?? []), [job]);

  const timeout = Number(timeoutMinutes) || 0;
  const attempts = Number(maxAttempts) || 1;
  const worstCaseHours = (timeout * attempts) / 60;
  const overBudget = worstCaseHours > 24;
  const dstWarning = dstSkipWarning(schedule, timezone);
  const canSave = name.trim() !== "" && command.trim() !== "" && !overBudget;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    const input = {
      name: name.trim(),
      description: description.trim(),
      service: service === SERVICE_INHERIT ? "" : service,
      schedule,
      timezone,
      shell,
      command: command.trim(),
      enabled,
      timeoutSeconds: Math.round(timeout * 60),
      maxAttempts: attempts,
      overlap,
      keepRuns: Number(keepRuns) || 50,
      workdir: workdir.trim(),
      user: user.trim(),
      ...(envTouched
        ? {
            env: env
              .filter((r) => r.key.trim() !== "")
              .map((r) => ({
                key: r.key.trim(),
                value:
                  r.value === "" && storedKeys.has(r.key.trim())
                    ? null
                    : r.value,
              })),
          }
        : {}),
    };
    startTransition(async () => {
      const res = job
        ? await gqlAction(UPDATE, { id: job.id, input })
        : await gqlAction(CREATE, { targetKind, targetId, input });
      if (res.ok) {
        toast.success(job ? "Cron job saved" : "Cron job created");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{job ? "Edit cron job" : "New cron job"}</DialogTitle>
          <DialogDescription className="mt-1">
            Runs inside the container, as the container&apos;s own user.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit}>
          <AnimatedHeight className="grid gap-4" scroll={false}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="cron-name"
                  info="What this job is for, in a few words."
                  docs="cron.create"
                >
                  Name
                </FieldLabel>
                <Input
                  id="cron-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nightly invoices"
                  autoFocus
                />
              </div>
              {/* A database is a single container, so there is nothing to pick. */}
              {services.length > 1 && (
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="cron-service"
                    info="Which container of the stack the command runs in. The service, not the container name - a redeploy renames those."
                    docs="cron.create"
                  >
                    Container
                  </FieldLabel>
                  <Select value={service} onValueChange={setService}>
                    <SelectTrigger id="cron-service">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SERVICE_INHERIT}>
                        The app&apos;s own
                        {primaryService ? ` (${primaryService})` : ""}
                      </SelectItem>
                      {services.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <SchedulePicker
              docs="cron.create"
              id="cron-schedule"
              value={schedule}
              onChange={setSchedule}
              timezone={timezone}
              trailing={
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="cron-timezone"
                    info="The clock this schedule is read on. Defaults to yours, so 03:00 means 03:00 where you are."
                    docs="cron.create"
                  >
                    Timezone
                  </FieldLabel>
                  {/* The READER's clock, not a server's: the whole point of the
                    field is "03:00 means 03:00 where you are". Safe to read at
                    render because the dialog's content only mounts on open. */}
                  <TimezonePicker
                    id="cron-timezone"
                    value={timezone}
                    onChange={setTimezone}
                    now={pickerNow}
                  />
                </div>
              }
            />
            {dstWarning && <p className="text-xs text-warning">{dstWarning}</p>}

            <div className="space-y-2">
              <FieldLabel
                htmlFor="cron-command"
                info="Run exactly as typed by the chosen shell, so pipes and && work. It cannot see your terminal - anything interactive will hang until the timeout."
                docs="cron.create"
              >
                Command
              </FieldLabel>
              <Textarea
                id="cron-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="php artisan schedule:run"
                rows={3}
                className="font-mono text-sm"
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <FieldLabel
                htmlFor="cron-enabled"
                info="A disabled job keeps its settings and its history, and simply does not fire."
                docs="cron.create"
              >
                Enabled
              </FieldLabel>
              <Switch
                id="cron-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            <Accordion type="single" collapsible>
              <AccordionItem value="advanced" className="border-none">
                <AccordionTrigger className="py-2 text-sm">
                  Advanced
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <FieldLabel
                      htmlFor="cron-description"
                      info="A note for whoever reads this list next."
                      docs="cron.create"
                    >
                      Description
                    </FieldLabel>
                    <Input
                      id="cron-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Sends yesterday's invoices"
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <FieldLabel
                        htmlFor="cron-shell"
                        info="A container without the shell you pick fails the run rather than quietly using the other one - they disagree about pipefail and [[."
                        docs="cron.create"
                      >
                        Shell
                      </FieldLabel>
                      <Select value={shell} onValueChange={setShell}>
                        <SelectTrigger id="cron-shell">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sh">sh</SelectItem>
                          <SelectItem value="bash">bash</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <FieldLabel
                        htmlFor="cron-overlap"
                        info="What happens when the previous run has not finished yet."
                        docs="cron.create"
                      >
                        If it is still running
                      </FieldLabel>
                      <Select value={overlap} onValueChange={setOverlap}>
                        <SelectTrigger id="cron-overlap">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="skip">Skip this run</SelectItem>
                          <SelectItem value="allow">Run it anyway</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <FieldLabel
                        htmlFor="cron-timeout"
                        info="How long ONE attempt may take before it is stopped. Per attempt, not per run."
                        docs="cron.create"
                      >
                        Timeout (minutes)
                      </FieldLabel>
                      <Input
                        id="cron-timeout"
                        type="number"
                        min={1}
                        max={1440}
                        value={timeoutMinutes}
                        onChange={(e) => setTimeoutMinutes(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel
                        htmlFor="cron-attempts"
                        info="Total launches per scheduled fire, a minute apart. 1 means no retry. Only the last attempt's output is kept."
                        docs="cron.history"
                      >
                        Attempts
                      </FieldLabel>
                      <Input
                        id="cron-attempts"
                        type="number"
                        min={1}
                        max={4}
                        value={maxAttempts}
                        onChange={(e) => setMaxAttempts(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel
                        htmlFor="cron-keep"
                        info="How many past runs to keep in the history."
                        docs="cron.history"
                      >
                        Runs kept
                      </FieldLabel>
                      <Input
                        id="cron-keep"
                        type="number"
                        min={10}
                        max={500}
                        value={keepRuns}
                        onChange={(e) => setKeepRuns(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel
                        htmlFor="cron-workdir"
                        info="Where the command starts. Empty ⇒ the image's own."
                        docs="cron.create"
                      >
                        Working directory
                      </FieldLabel>
                      <Input
                        id="cron-workdir"
                        value={workdir}
                        onChange={(e) => setWorkdir(e.target.value)}
                        placeholder="/app"
                        className="font-mono text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel
                        htmlFor="cron-user"
                        info="Who the command runs as. Empty ⇒ the image's own user."
                        docs="cron.create"
                      >
                        User
                      </FieldLabel>
                      <Input
                        id="cron-user"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        placeholder="root"
                        className="font-mono text-sm"
                      />
                    </div>
                  </div>

                  {/* The two multiply, and the server refuses the product - better
                    to say so while it can still be changed. */}
                  {attempts > 1 && (
                    <p
                      className={
                        overBudget
                          ? "text-xs text-destructive"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {attempts} attempts of {timeout} minutes could take up to{" "}
                      {worstCaseHours % 1 === 0
                        ? worstCaseHours
                        : worstCaseHours.toFixed(1)}{" "}
                      hours.
                      {overBudget
                        ? " Lower the timeout or the attempts to fit in 24."
                        : ""}
                    </p>
                  )}

                  <div className="space-y-2">
                    <FieldLabel
                      info="Set only for this job, on top of the container's own. Values are write-only - they can be replaced, never read back."
                      docs="env.overview"
                    >
                      Variables
                    </FieldLabel>
                    {env.map((row, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={row.key}
                          onChange={(e) => {
                            setEnvTouched(true);
                            setEnv((rows) =>
                              rows.map((r, j) =>
                                j === i ? { ...r, key: e.target.value } : r,
                              ),
                            );
                          }}
                          placeholder="API_KEY"
                          className="font-mono text-sm"
                        />
                        <Input
                          value={row.value}
                          onChange={(e) => {
                            setEnvTouched(true);
                            setEnv((rows) =>
                              rows.map((r, j) =>
                                j === i ? { ...r, value: e.target.value } : r,
                              ),
                            );
                          }}
                          placeholder={
                            storedKeys.has(row.key) ? "Unchanged" : "value"
                          }
                          type="password"
                          className="font-mono text-sm"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${row.key || "variable"}`}
                          onClick={() => {
                            setEnvTouched(true);
                            setEnv((rows) => rows.filter((_, j) => j !== i));
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEnvTouched(true);
                        setEnv((rows) => [...rows, { key: "", value: "" }]);
                      }}
                    >
                      <Plus className="size-4" />
                      Add variable
                    </Button>
                    {job && envTouched && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        A stored variable left blank keeps its value. Remove a
                        row to drop it.
                      </p>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </AnimatedHeight>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !canSave}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {job ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

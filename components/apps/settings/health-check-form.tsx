"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HeartPulse } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { gqlAction } from "@/lib/graphql-client";
import {
  healthCheckFromForm,
  healthCheckProblem,
  healthCheckToForm,
  type HealthCheckForm,
} from "@/lib/apps/health-check-model";
import type { HealthCheck } from "@/lib/types";

/**
 * One app's health check. Off until somebody turns it on, because an app that
 * answers nothing is not broken - it just has no check.
 */

const SAVE = /* GraphQL */ `
  mutation ($id: String!, $input: HealthCheckInput) {
    updateAppHealthCheck(id: $id, input: $input) {
      id
    }
  }
`;

export function HealthCheckForm({
  appId,
  healthCheck,
}: {
  appId: string;
  healthCheck: HealthCheck | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<HealthCheckForm>(() =>
    healthCheckToForm(healthCheck),
  );

  const set = <K extends keyof HealthCheckForm>(
    key: K,
    value: HealthCheckForm[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  const problem = healthCheckProblem(healthCheckFromForm(form));

  function save(next: HealthCheckForm) {
    const input = healthCheckFromForm(next);
    const bad = healthCheckProblem(input);
    if (bad) {
      toast.error(bad);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction(SAVE, { id: appId, input });
      if (res.ok) {
        toast.success(input ? "Health check saved" : "Health check is off");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <div id="health-check" className="scroll-mt-20 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-56 flex-1 space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <HeartPulse className="size-4 text-muted-foreground" />
            Health check
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask the app whether it is really working, not just running.
          </p>
        </div>
        <Switch
          id="health-check-enabled"
          checked={form.enabled}
          disabled={pending}
          onCheckedChange={(v) => {
            const next = { ...form, enabled: v };
            setForm(next);
            // Turning it off is a save on its own; turning it on waits for the
            // fields, so nobody lands a check that has not been filled in.
            if (!v) save(next);
          }}
        />
      </div>

      {form.enabled && (
        <form
          className="mt-4 grid gap-4 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            save(form);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="health-check-type"
                info="HTTP asks the app for a path over localhost. Command runs a shell line inside the container and reads its exit code."
              >
                Check
              </FieldLabel>
              <Select
                value={form.type}
                onValueChange={(v) => set("type", v as "http" | "command")}
              >
                <SelectTrigger id="health-check-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP request</SelectItem>
                  <SelectItem value="command">Command</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.type === "http" ? (
              <>
                <div className="grid gap-2">
                  <FieldLabel
                    htmlFor="health-check-path"
                    info="Needs curl or wget in the image. An image with neither cannot answer an HTTP check."
                  >
                    Path
                  </FieldLabel>
                  <Input
                    id="health-check-path"
                    value={form.path}
                    onChange={(e) => set("path", e.target.value)}
                    placeholder="/healthz"
                    spellCheck={false}
                  />
                </div>
                <div className="grid gap-2">
                  <FieldLabel
                    htmlFor="health-check-port"
                    info="The port inside the container. Leave it empty to use the app's own port."
                  >
                    Port
                  </FieldLabel>
                  <Input
                    id="health-check-port"
                    value={form.port}
                    onChange={(e) => set("port", e.target.value)}
                    placeholder="The app's port"
                    inputMode="numeric"
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-2 sm:col-span-2">
                <FieldLabel
                  htmlFor="health-check-command"
                  info="Runs through a shell, so a pipe or a fallback works. Exit 0 means healthy."
                >
                  Command
                </FieldLabel>
                <Input
                  id="health-check-command"
                  value={form.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="pg_isready -U app"
                  spellCheck={false}
                />
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            {(
              [
                ["intervalS", "Interval", "Seconds between checks."],
                [
                  "timeoutS",
                  "Timeout",
                  "Seconds one check may take before it counts as a failure.",
                ],
                [
                  "retries",
                  "Retries",
                  "Consecutive failures before the app is called unhealthy.",
                ],
                [
                  "startPeriodS",
                  "Start period",
                  "Seconds of grace while the app boots, when a failure does not count.",
                ],
              ] as const
            ).map(([key, label, info]) => (
              <div key={key} className="grid gap-2">
                <FieldLabel htmlFor={`health-check-${key}`} info={info}>
                  {label}
                </FieldLabel>
                <Input
                  id={`health-check-${key}`}
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                  inputMode="numeric"
                />
              </div>
            ))}
          </div>

          {problem && <p className="text-sm text-destructive">{problem}</p>}

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Applied on the next deploy.
            </p>
            <Button type="submit" disabled={pending || problem != null}>
              Save
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

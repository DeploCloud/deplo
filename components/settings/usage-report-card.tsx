"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/shared/copy-button";
import { gqlAction } from "@/lib/graphql-client";
import { formatDateTime } from "@/lib/utils";

export function UsageReportCard({
  enabled,
  forcedOff,
  lastSentAt,
}: {
  enabled: boolean;
  forcedOff: boolean;
  lastSentAt: string | null;
}) {
  const router = useRouter();
  const [on, setOn] = React.useState(enabled);
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<PreviewState>({
    kind: "loading",
  });

  function toggle(next: boolean) {
    const previous = on;
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        /* GraphQL */ `
          mutation ($enabled: Boolean!) {
            setUsageReportsEnabled(enabled: $enabled) {
              usageReportsEnabled
            }
          }
        `,
        { enabled: next },
      );
      if (res.ok) {
        router.refresh();
        toast.success(
          next
            ? "Anonymous usage statistics are on"
            : "Anonymous usage statistics are off",
        );
      } else {
        setOn(previous);
        toast.error(res.error);
      }
    });
  }

  function showReport() {
    setPreview({ kind: "loading" });
    setOpen(true);
    void gqlAction<{ usageReport: UsageReportPreview }, UsageReportPreview>(
      /* GraphQL */ `
        query {
          usageReport {
            json
            instanceId
            lastSentAt
          }
        }
      `,
      undefined,
      (d) => d.usageReport,
    ).then((res) =>
      setPreview(
        res.ok && res.data
          ? { kind: "ready", report: res.data }
          : { kind: "error", message: res.ok ? "No report" : res.error },
      ),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="size-4 text-muted-foreground" />
          Anonymous usage statistics
        </CardTitle>
        <CardDescription>
          One report a day with versions, counts and feature switches, and
          nothing that names this instance.{" "}
          <DocsLink topic="instance.usageReports" />
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <FieldLabel
              htmlFor="usage-reports-enabled"
              info="Off stops the next report and clears the instance id, so turning it on again starts a history that cannot be joined to the old one."
            >
              Send usage statistics
            </FieldLabel>
            {forcedOff && (
              <p className="mt-1 text-xs text-muted-foreground">
                Turned off by the install
              </p>
            )}
          </div>
          <Switch
            id="usage-reports-enabled"
            checked={forcedOff ? false : on}
            disabled={pending || forcedOff}
            onCheckedChange={toggle}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Last sent: {lastSentAt ? formatDateTime(lastSentAt) : "Never"}
          </p>
          <Button variant="outline" size="sm" onClick={showReport}>
            See what would be sent
          </Button>
        </div>
      </CardContent>

      <UsageReportDialog open={open} onOpenChange={setOpen} preview={preview} />
    </Card>
  );
}

interface UsageReportPreview {
  json: string;
  instanceId: string | null;
  lastSentAt: string | null;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; report: UsageReportPreview }
  | { kind: "error"; message: string };

function UsageReportDialog({
  open,
  onOpenChange,
  preview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: PreviewState;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What would be sent</DialogTitle>
          <DialogDescription>
            The report as it stands right now, from live data.{" "}
            <strong>Nothing in it names this instance.</strong>
          </DialogDescription>
        </DialogHeader>
        {preview.kind === "error" ? (
          <p className="text-sm text-destructive">{preview.message}</p>
        ) : preview.kind === "ready" ? (
          <div className="grid gap-3">
            <div className="relative">
              <div className="absolute top-2 right-2 z-10">
                <CopyButton value={preview.report.json} />
              </div>
              <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-surface p-3 pr-12 font-mono text-xs text-muted-foreground">
                {preview.report.json}
              </pre>
            </div>
            <p className="text-xs text-muted-foreground">
              Instance id:{" "}
              <span className="font-mono text-foreground">
                {preview.report.instanceId ?? "assigned on the first send"}
              </span>
              {" · "}Last sent:{" "}
              {preview.report.lastSentAt
                ? formatDateTime(preview.report.lastSentAt)
                : "Never"}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Building the report…</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

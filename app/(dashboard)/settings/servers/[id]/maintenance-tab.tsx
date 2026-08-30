"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, RotateCcw, Route } from "lucide-react";

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
import { DeploMark } from "@/components/logo";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "./server-detail-tabs";
import { DocsLink } from "@/components/ui/docs-link";

/**
 * The Maintenance tab: the restarts an operator used to need SSH for.
 */

type ActionId = "workloads" | "traefik" | "panel" | null;

type RestartReport = {
  restarted: number;
  skipped: number;
  failures: Array<{ kind: string; name: string; error: string | null }>;
};

export function ServerMaintenanceTab({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirm, setConfirm] = React.useState<ActionId>(null);

  function restartWorkloads() {
    startTransition(async () => {
      const res = await gqlAction<{ restartServerWorkloads: RestartReport }>(
        `mutation RestartServerWorkloads($id: String!) {
          restartServerWorkloads(id: $id) {
            restarted
            skipped
            failures { kind name error }
          }
        }`,
        { id: server.id },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConfirm(null);
      const report = res.data?.restartServerWorkloads;
      if (!report) return;
      // Partial success is the normal outcome and is reported as one: a summary
      // that only counted the wins would hide the stack that did not come back.
      if (report.failures.length > 0) {
        toast.warning(
          `Restarted ${report.restarted}; ${report.failures.length} failed: ` +
            report.failures.map((f) => `${f.name} (${f.error})`).join(", "),
        );
      } else if (report.restarted === 0) {
        // "left alone" rather than "stopped": the bucket also holds workloads with
        // a deploy in flight, and those are anything but stopped.
        toast.info(
          report.skipped > 0
            ? `Nothing to restart, ${report.skipped} left alone`
            : "Nothing is running on this server",
        );
      } else {
        toast.success(
          `Restarted ${report.restarted} workload${report.restarted === 1 ? "" : "s"}` +
            (report.skipped > 0 ? `, left ${report.skipped} alone` : ""),
        );
      }
      router.refresh();
    });
  }

  function restartTraefik() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation RestartServerTraefik($id: String!) { restartServerTraefik(id: $id) }`,
        { id: server.id },
      );
      if (!res.ok) {
        // Includes "Deplo did not install Traefik on this host" - the host's own
        // answer, which is more useful than anything we could word for it.
        toast.error(res.error);
        return;
      }
      setConfirm(null);
      toast.success("Traefik restarted");
    });
  }

  function restartPanel() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation RestartDeploPanel($id: String!) { restartDeploPanel(id: $id) }`,
        { id: server.id },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConfirm(null);
      // Not "restarted": the mutation returns once the restart is SCHEDULED,
      // because the restart ends the process that would have reported it done.
      toast.success(
        "Deplo is restarting - this page will be briefly unavailable",
      );
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RotateCcw className="size-4" />
            Restart
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Bring things back up on this server. Each one interrupts something -
            you will be told what before it runs.{" "}
            <DocsLink topic="servers.maintenance" />
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <ActionRow
            icon={RefreshCw}
            title="Apps and databases"
            description="Restarts everything Deplo runs here. Anything stopped or mid-deploy is left alone."
            action={
              <Button
                variant="outline"
                onClick={() => setConfirm("workloads")}
                disabled={pending}
              >
                Restart all
              </Button>
            }
          />
          <ActionRow
            icon={Route}
            title="Traefik"
            description="The reverse proxy that routes traffic to every site on this server."
            action={
              <Button
                variant="outline"
                onClick={() => setConfirm("traefik")}
                disabled={pending}
              >
                Restart Traefik
              </Button>
            }
          />
          {/* Only on the host that runs the panel: on a remote there is nothing
              to restart, and offering a button that can only fail is worse than
              not offering it. */}
          {server.isDeploHost ? (
            <ActionRow
              icon={DeploMark}
              title="Deplo panel"
              description="Restarts Deplo itself. Your deployed apps keep running."
              action={
                <Button
                  variant="outline"
                  onClick={() => setConfirm("panel")}
                  disabled={pending}
                >
                  Restart Deplo
                </Button>
              }
            />
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={confirm === "workloads"}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart everything on {server.name}?</DialogTitle>
            <DialogDescription>
              Every app and database Deplo runs on this server is stopped and
              started again, one at a time. Each is briefly unreachable.
              Anything already stopped stays stopped, and anything mid-deploy is
              left to finish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={() => restartWorkloads()} disabled={pending}>
              {pending ? "Restarting" : "Restart all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirm === "traefik"}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart Traefik on {server.name}?</DialogTitle>
            <DialogDescription>
              Traefik routes traffic to every site on this server, so all of
              them are unreachable for the few seconds it takes to come back.
              The containers themselves keep running.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={() => restartTraefik()} disabled={pending}>
              {pending ? "Restarting" : "Restart Traefik"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirm === "panel"}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart Deplo?</DialogTitle>
            <DialogDescription>
              This dashboard goes away for a few seconds and comes back on its
              own. Your deployed apps and databases are not affected - they keep
              serving traffic throughout.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={() => restartPanel()} disabled={pending}>
              {pending ? "Restarting" : "Restart Deplo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One labelled action: icon + title + one line of what it does + the button. */
function ActionRow({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

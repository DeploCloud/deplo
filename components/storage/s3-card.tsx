"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  PlugZap,
  ScrollText,
  Trash2,
  Cloud,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  S3TestLogDialog,
  S3_TEST_REPORT_FIELDS,
  type S3TestReportView,
} from "@/components/storage/s3-test-log-dialog";
import { timeAgo } from "@/lib/utils";
import { gql, gqlAction } from "@/lib/graphql-client";
import type { S3DestinationDTO } from "@/lib/data/s3";

/**
 * The first line of an agent message, for the toast. S3 errors can arrive as a
 * multi-line provider dump; the toast gets the actionable first line and the
 * connection log keeps every byte.
 */
function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

const PROVIDER_LABEL: Record<string, string> = {
  aws: "Amazon S3",
  "cloudflare-r2": "Cloudflare R2",
  "backblaze-b2": "Backblaze B2",
  digitalocean: "DigitalOcean Spaces",
  wasabi: "Wasabi",
  minio: "MinIO",
  other: "S3-compatible",
};

export function S3Card({ dest }: { dest: S3DestinationDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);

  /**
   * Test the bucket and say what actually happened.
   *
   * A failed probe is a NORMAL result of this mutation, not an error — which is
   * exactly how the old version came to announce "Connection verified" over a
   * destination the agent had just refused: it only checked that the request
   * succeeded. The verdict lives in `report.ok`, and the reason (`report.error`,
   * the agent's own words) goes straight into the toast with a shortcut to the
   * full log.
   */
  function test() {
    startTransition(async () => {
      try {
        const data = await gql<{ testS3: { report: S3TestReportView } }>(
          `mutation ($id: String!) { testS3(id: $id) { report { ${S3_TEST_REPORT_FIELDS} } } }`,
          { id: dest.id },
        );
        const report = data.testS3.report;
        // Repaint the badge from the persisted verdict either way.
        router.refresh();
        if (report.ok) {
          toast.success(
            `${dest.name} is reachable and writable${
              report.serverName ? ` from ${report.serverName}` : ""
            }`,
          );
          return;
        }
        toast.error(firstLine(report.error) || "The bucket could not be reached", {
          description: "Open the connection log for the full output",
          action: { label: "Open log", onClick: () => setLogOpen(true) },
        });
      } catch (e) {
        // The mutation itself failed (offline, not permitted, destination gone):
        // no verdict was recorded, so say only what we know.
        toast.error(e instanceof Error ? e.message : "The test could not run");
      }
    });
  }

  const cardInner = (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary">
              <Cloud className="size-5" />
            </div>
            <div>
              <p className="font-medium">{dest.name}</p>
              <p className="text-xs text-muted-foreground">
                {PROVIDER_LABEL[dest.provider] ?? dest.provider}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={dest.status} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Destination menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <SimpleTooltip
                  content="Verify this destination's credentials and reachability"
                  side="left"
                >
                  <DropdownMenuItem onClick={test} disabled={pending}>
                    <PlugZap className="size-4" />
                    Test connection
                  </DropdownMenuItem>
                </SimpleTooltip>
                <SimpleTooltip
                  content="Read the full output of the last connection test, and the commands that reproduce it"
                  side="left"
                >
                  <DropdownMenuItem onSelect={() => setLogOpen(true)}>
                    <ScrollText className="size-4" />
                    Connection log
                  </DropdownMenuItem>
                </SimpleTooltip>
                <DropdownMenuSeparator />
                <SimpleTooltip
                  content="Remove this destination — bucket contents are not affected"
                  side="left"
                >
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setConfirmOpen(true)}
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </DropdownMenuItem>
                </SimpleTooltip>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Bucket</dt>
            <dd className="font-mono">{dest.bucket}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Region</dt>
            <dd className="font-mono">{dest.region}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="truncate font-mono">{dest.endpoint}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Access key</dt>
            <dd className="font-mono">{dest.accessKeyMasked}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Added</dt>
            <dd>{timeAgo(dest.createdAt)}</dd>
          </div>
        </dl>

        {/* Why the badge is red, right on the card. The status alone used to be
            the whole story, so a failing destination said "Error" and stopped. */}
        {dest.lastTestError && (
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            className="flex w-full items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-left transition-colors hover:bg-destructive/10"
          >
            <ScrollText className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block truncate text-xs text-destructive">
                {firstLine(dest.lastTestError)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {dest.lastTestAt
                  ? `Last tested ${timeAgo(dest.lastTestAt)} — open the connection log`
                  : "Open the connection log"}
              </span>
            </span>
          </button>
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      {cardInner}

      <S3TestLogDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        destinationId={dest.id}
        destinationName={dest.name}
        // A re-run from inside the dialog repaints the card's badge too.
        onTested={() => router.refresh()}
      />

      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Remove ${dest.name}?`}
        description="Backups configured to use this destination will stop running. Your bucket contents are not affected."
        confirmLabel="Remove destination"
        successMessage="Destination removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation ($id: String!) { deleteS3(id: $id) }`,
            { id: dest.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}

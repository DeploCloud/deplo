"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Cloud,
  KeyRound,
  MoreHorizontal,
  PlugZap,
  ScrollText,
  Server,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  DestinationTestLogDialog,
  S3_TEST_REPORT_FIELDS,
  type S3TestReportView,
} from "@/components/storage/destination-test-log-dialog";
import { formatBytes, timeAgo } from "@/lib/utils";
import { gql, gqlAction } from "@/lib/graphql-client";

/**
 * The first line of an agent message, for the toast. Errors can arrive as a
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

/** What the card needs. Narrower than the DTO — no secrets reach the client. */
export interface DestinationCardView {
  id: string;
  name: string;
  kind: "s3" | "server";
  where: string;
  status: "connected" | "error" | "unverified";
  createdAt: string;
  lastTestAt: string | null;
  lastTestError: string | null;
  provider: string | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyMasked: string | null;
  serverName: string | null;
  resolvedPath: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
  recoveryKeySavedAt: string | null;
}

export function DestinationCard({
  dest,
  canManage,
}: {
  dest: DestinationCardView;
  /** `manage_backup_destinations`. Gates testing, the recovery key and removal. */
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);
  const isServer = dest.kind === "server";

  /**
   * Test the destination and say what actually happened.
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
        const data = await gql<{ testDestination: { report: S3TestReportView } }>(
          `mutation ($id: String!) { testDestination(id: $id) { report { ${S3_TEST_REPORT_FIELDS} } } }`,
          { id: dest.id },
        );
        const report = data.testDestination.report;
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
        toast.error(firstLine(report.error) || "The destination could not be reached", {
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

  /**
   * Hand over the recovery key as a file.
   *
   * Downloading rather than showing: this key is meant to leave Deplo and be
   * kept somewhere else, and a string on screen invites a screenshot instead.
   * The download also stamps the destination as saved, which is what stops the
   * nudge below.
   */
  function downloadRecoveryKey() {
    startTransition(async () => {
      try {
        const data = await gql<{
          destinationRecoveryKey: { name: string; recipient: string; identity: string };
        }>(
          `mutation ($id: String!) { destinationRecoveryKey(id: $id) { name recipient identity } }`,
          { id: dest.id },
        );
        const key = data.destinationRecoveryKey;
        // The age key-file format: comments, then the secret key on its own line.
        // `age -d -i this-file backup.tar.gz.age` reads it as-is.
        const body =
          `# Deplo backup recovery key for "${key.name}"\n` +
          `# Keep this somewhere outside Deplo. Without it, the backups at this\n` +
          `# destination cannot be read if this instance is lost.\n` +
          `#\n` +
          `#   age -d -i deplo-recovery-key.txt backup.tar.gz.age > backup.tar.gz\n` +
          `#\n` +
          `# public key: ${key.recipient}\n` +
          `${key.identity}\n`;
        const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "deplo-recovery-key.txt";
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Recovery key downloaded", {
          description: "Keep it somewhere outside Deplo",
        });
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "The recovery key could not be read");
      }
    });
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary">
                {isServer ? <Server className="size-5" /> : <Cloud className="size-5" />}
              </div>
              <div>
                <p className="flex items-center gap-2 font-medium">
                  {dest.name}
                  {isServer && (
                    <Badge variant="info" className="px-1.5 py-0 text-[10px] font-normal">
                      Beta
                    </Badge>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isServer
                    ? (dest.serverName ?? "A removed server")
                    : (PROVIDER_LABEL[dest.provider ?? ""] ?? dest.provider)}
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
                <DropdownMenuContent align="end" className="w-52">
                  <SimpleTooltip
                    content="Verify this destination is reachable and writable"
                    side="left"
                  >
                    <DropdownMenuItem onClick={test} disabled={pending || !canManage}>
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
                  {isServer && (
                    <SimpleTooltip
                      content="The key that decrypts these backups. Keep it outside Deplo."
                      side="left"
                    >
                      <DropdownMenuItem
                        onClick={downloadRecoveryKey}
                        disabled={pending || !canManage}
                      >
                        <KeyRound className="size-4" />
                        Download recovery key
                      </DropdownMenuItem>
                    </SimpleTooltip>
                  )}
                  <DropdownMenuSeparator />
                  <SimpleTooltip
                    content="Remove this destination — the backup files themselves are not deleted"
                    side="left"
                  >
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={!canManage}
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
            {isServer ? (
              <>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Folder</dt>
                  <dd className="truncate font-mono">{dest.resolvedPath ?? "Not set up yet"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Free space</dt>
                  <dd>
                    {dest.freeBytes !== null && dest.totalBytes
                      ? `${formatBytes(dest.freeBytes)} of ${formatBytes(dest.totalBytes)}`
                      : "Not tested yet"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Encryption</dt>
                  <dd>Always on</dd>
                </div>
              </>
            ) : (
              <>
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
              </>
            )}
            <div>
              <dt className="text-muted-foreground">Added</dt>
              <dd>{timeAgo(dest.createdAt)}</dd>
            </div>
          </dl>

          {/* The recovery-key nudge. These backups are encrypted, so a key kept
              only inside Deplo is a key that dies with the instance the backups
              exist to survive. Stays until someone downloads it. */}
          {isServer && canManage && !dest.recoveryKeySavedAt && (
            <button
              type="button"
              onClick={downloadRecoveryKey}
              disabled={pending}
              className="flex w-full items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-left transition-colors hover:bg-[var(--warning)]/10"
            >
              <KeyRound className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-xs font-medium">Save your recovery key</span>
                <span className="block text-xs text-muted-foreground">
                  These backups are encrypted. Without this key they cannot be read if
                  you lose this instance.
                </span>
              </span>
            </button>
          )}

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

      <DestinationTestLogDialog
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
        description={
          isServer
            ? "Backups configured to use this destination will stop running. The backup files on the server are not deleted."
            : "Backups configured to use this destination will stop running. Your bucket contents are not affected."
        }
        confirmLabel="Remove destination"
        successMessage="Destination removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation ($id: String!) { deleteDestination(id: $id) }`,
            { id: dest.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}

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
import { Checkbox } from "@/components/ui/checkbox";
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

/** What removing a destination destroys, so the dialog can name it. */
interface RemovalImpact {
  schedules: number;
  runs: number;
  artifacts: number;
}

/** The destination's name, flattened into something safe for a filename. */
function keyFileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "destination"
  );
}

/** "3 schedules", "1 schedule" - the plural nobody should hand-write twice. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

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
  /** Whether artifacts written here are encrypted — true for every server
   *  destination, and for any bucket connected since buckets were encrypted. */
  encrypted: boolean;
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
  // What the removal takes with it, fetched when the dialog opens. Null while
  // unknown, so the copy never asserts a count it does not have.
  const [impact, setImpact] = React.useState<RemovalImpact | null>(null);
  const [alsoDeleteFiles, setAlsoDeleteFiles] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);
  const isServer = dest.kind === "server";
  // What decides whether there is a key to save is the KEYPAIR, not the kind: a
  // bucket connected since bucket artifacts started being encrypted has one too,
  // and gating on `isServer` left those backups locked by a key that existed
  // only inside the instance they are meant to survive.
  const encrypted = dest.encrypted;

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
          `# Deplo backups - recovery key for the destination "${key.name}"\n` +
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
        // Named for what it is AND which destination it opens. This file ends up
        // in a password manager or a drawer, years before anyone needs it, next
        // to whatever else was downloaded that day - "deplo-recovery-key.txt"
        // told its finder neither product nor purpose, and an instance with two
        // destinations produced two files with the same name.
        a.download = `deplo-backups-recovery-key-${keyFileSlug(key.name)}.txt`;
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

  // Reset on CLOSE, in the handler rather than in the effect: a synchronous
  // setState inside an effect cascades a render, and the repo's dialogs already
  // do their resetting where the close actually happens.
  function onConfirmOpenChange(next: boolean) {
    if (!next) {
      setImpact(null);
      setAlsoDeleteFiles(false);
    }
    setConfirmOpen(next);
  }

  // Fetch the impact each time the dialog opens - a backup may have run since.
  React.useEffect(() => {
    if (!confirmOpen) return;
    let cancelled = false;
    gql<{ destinationRemovalImpact: RemovalImpact }>(
      `query ($id: String!) {
        destinationRemovalImpact(id: $id) { schedules runs artifacts }
      }`,
      { id: dest.id },
    )
      .then((d) => {
        if (!cancelled) setImpact(d.destinationRemovalImpact);
      })
      .catch(() => {
        // Unknown stays unknown: the dialog then says only what it is sure of.
        if (!cancelled) setImpact(null);
      });
    return () => {
      cancelled = true;
    };
  }, [confirmOpen, dest.id]);

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
                    <DropdownMenuItem
                      // destinationTestReport declares the same capability the
                      // test does, so without this the item is a click that ends
                      // in an authorization error for a plain Member.
                      disabled={!canManage}
                      onSelect={() => setLogOpen(true)}
                    >
                      <ScrollText className="size-4" />
                      Connection log
                    </DropdownMenuItem>
                  </SimpleTooltip>
                  {encrypted && (
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
                <div>
                  <dt className="text-muted-foreground">Encryption</dt>
                  <dd>{encrypted ? "Always on" : "Off (older destination)"}</dd>
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
          {encrypted && canManage && !dest.recoveryKeySavedAt && (
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
          {dest.lastTestError && canManage && (
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

      {/* The copy used to say backups "will stop running", which was not what
          happened: the schedules and the whole run history are DELETED. And for
          a server destination "the files are not deleted" left them on that disk
          with nothing in Deplo able to name them again — reclaimable only over
          SSH, which is the one thing this platform exists to make unnecessary.
          So: say the real numbers, and offer the sweep. */}
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={onConfirmOpenChange}
        title={`Remove ${dest.name}?`}
        description={
          <span className="flex flex-col gap-2">
            <span>
              {impact && (impact.schedules > 0 || impact.runs > 0)
                ? `This deletes ${plural(impact.schedules, "backup schedule")} and ${plural(impact.runs, "restore point")}. `
                : "This deletes the backup schedules and restore points that use it. "}
              {alsoDeleteFiles
                ? "The backup files are deleted too."
                : isServer
                  ? "The backup files stay on the server."
                  : "Your bucket contents are not affected."}
            </span>
          </span>
        }
        extra={
          impact && impact.artifacts > 0 ? (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
              <Checkbox
                checked={alsoDeleteFiles}
                onCheckedChange={(v) => setAlsoDeleteFiles(v === true)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  Also delete the {plural(impact.artifacts, "backup file")}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {isServer
                    ? "Frees the space on the server. Without this they stay on disk and Deplo can no longer reach them."
                    : "Removes the objects from your bucket. Without this they stay there for you to manage yourself."}
                </span>
              </span>
            </label>
          ) : undefined
        }
        // Typed, like a restore. This deletes every schedule and the whole run
        // history, and with the box ticked the backup files as well - there is no
        // undo for any of it, and it used to be one click.
        confirmText={dest.name}
        confirmLabel="Remove destination"
        successMessage="Destination removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation ($id: String!, $deleteArtifacts: Boolean) {
              deleteDestination(id: $id, deleteArtifacts: $deleteArtifacts)
            }`,
            { id: dest.id, deleteArtifacts: alsoDeleteFiles },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  KeyRound,
  MoreHorizontal,
  PlugZap,
  ScrollText,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  DestinationTestLogDialog,
  S3_TEST_REPORT_FIELDS,
  type S3TestReportView,
} from "@/components/storage/destination-test-log-dialog";
import {
  downloadRecoveryKey,
  RecoveryKeyNudge,
} from "@/components/storage/recovery-key";
import { useOptimisticRow } from "@/components/shared/optimistic-list";
import { gql, gqlAction } from "@/lib/graphql-client";

// DestinationCardView - what the card and the table row need. Narrower than the DTO, no secrets.
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
  // True for every server destination, and for any bucket connected since buckets were encrypted.
  encrypted: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  storedBytes: number;
  storedCount: number;
  recoveryKeySavedAt: string | null;
}

export const PROVIDER_LABEL: Record<string, string> = {
  aws: "Amazon S3",
  "cloudflare-r2": "Cloudflare R2",
  "backblaze-b2": "Backblaze B2",
  digitalocean: "DigitalOcean Spaces",
  wasabi: "Wasabi",
  minio: "MinIO",
  other: "S3-compatible",
};

interface RemovalImpact {
  schedules: number;
  runs: number;
  artifacts: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// firstLine - the actionable first line of a multi-line provider dump, for the toast.
export function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

// useDestinationActions - the ⋯ menu, connection log, removal confirm and test, shared by the card and the table row.
export function useDestinationActions({
  dest,
  canManage,
}: {
  dest: DestinationCardView;
  // `manage_backup_destinations`. Gates testing, the recovery key and removal.
  canManage: boolean;
}): {
  pending: boolean;
  test: () => void;
  saveRecoveryKey: () => void;
  openLog: () => void;
  menu: React.ReactNode;
  dialogs: React.ReactNode;
} {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // The row leaves on the click: the destination is dropped server-side before a sweep that can run as long as the bucket is big.
  const { hide, restore } = useOptimisticRow(dest.id);
  // Null while unknown, so the copy never asserts a count it does not have.
  const [impact, setImpact] = React.useState<RemovalImpact | null>(null);
  const [alsoDeleteFiles, setAlsoDeleteFiles] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);
  const isServer = dest.kind === "server";
  const encrypted = dest.encrypted;

  const test = React.useCallback(() => {
    startTransition(async () => {
      try {
        const data = await gql<{
          testDestination: { report: S3TestReportView };
        }>(
          `mutation ($id: String!) { testDestination(id: $id) { report { ${S3_TEST_REPORT_FIELDS} } } }`,
          { id: dest.id },
        );
        const report = data.testDestination.report;
        // Unconditional: the verdict is persisted server-side, so a refresh repaints the badge and the free-space figure.
        router.refresh();
        if (report.ok) {
          toast.success(
            `${dest.name} is reachable and writable${
              report.serverName ? ` from ${report.serverName}` : ""
            }`,
          );
          return;
        }
        toast.error(
          firstLine(report.error) || "The destination could not be reached",
          {
            description: "Open the connection log for the full output",
            action: { label: "Open log", onClick: () => setLogOpen(true) },
          },
        );
      } catch (e) {
        // The mutation itself failed, so no verdict was recorded: say only what we know.
        toast.error(e instanceof Error ? e.message : "The test could not run");
      }
    });
  }, [dest.id, dest.name, router]);

  const saveRecoveryKey = React.useCallback(() => {
    startTransition(async () => {
      if (await downloadRecoveryKey(dest.id)) router.refresh();
    });
  }, [dest.id, router]);

  // Reset in the close handler, not an effect: a synchronous setState inside an effect cascades a render.
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

  const menu = (
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
            // destinationTestReport declares the same capability the test does: without this a plain Member clicks into an authorization error.
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
              onClick={saveRecoveryKey}
              disabled={pending || !canManage}
            >
              <KeyRound className="size-4" />
              Download recovery key
            </DropdownMenuItem>
          </SimpleTooltip>
        )}
        <DropdownMenuSeparator />
        <SimpleTooltip
          content="Remove this destination - the backup files themselves are not deleted"
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
  );

  const dialogs = (
    <>
      <DestinationTestLogDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        destinationId={dest.id}
        destinationName={dest.name}
        onTested={() => router.refresh()}
      />

      {/* The copy used to say backups "will stop running": the schedules and the whole run history are DELETED. */}
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={onConfirmOpenChange}
        title="Remove destination?"
        description={
          <>
            Removing <strong>{dest.name}</strong> deletes{" "}
            {impact && (impact.schedules > 0 || impact.runs > 0)
              ? `${plural(impact.schedules, "backup schedule")} and ${plural(impact.runs, "restore point")}`
              : "the backup schedules and restore points that use it"}
            .{" "}
            {!alsoDeleteFiles &&
              (isServer
                ? "The backup files stay on the server."
                : "Your bucket contents are not affected.")}{" "}
            {!alsoDeleteFiles && encrypted && (
              <DocsLink topic="backups.recoveryKey" />
            )}
          </>
        }
        consequence={
          alsoDeleteFiles
            ? "The backup files are deleted too, and nothing can be restored from them afterwards."
            : undefined
        }
        extra={
          impact && impact.artifacts > 0 ? (
            <div className="grid gap-3">
              {/* Removing the destination deletes its keypair with it. */}
              {encrypted && !alsoDeleteFiles && !dest.recoveryKeySavedAt && (
                <RecoveryKeyNudge
                  destinationId={dest.id}
                  title="Take the recovery key first"
                  description={`The ${plural(impact.artifacts, "backup file")} you keep are encrypted, and removing this destination deletes the only key that opens them.`}
                  onSaved={() => router.refresh()}
                />
              )}
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
            </div>
          ) : undefined
        }
        // Typed, like a restore: none of this can be undone, and it used to be one click.
        confirmText={dest.name}
        confirmLabel="Remove destination"
        successMessage="Destination removed"
        optimistic
        onConfirm={async () => {
          hide();
          const res = await gqlAction(
            `mutation ($id: String!, $deleteArtifacts: Boolean) {
              deleteDestination(id: $id, deleteArtifacts: $deleteArtifacts)
            }`,
            { id: dest.id, deleteArtifacts: alsoDeleteFiles },
          );
          if (!res.ok) restore();
          router.refresh();
          return res;
        }}
      />
    </>
  );

  return {
    pending,
    test,
    saveRecoveryKey,
    openLog: () => setLogOpen(true),
    menu,
    dialogs,
  };
}

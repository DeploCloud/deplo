"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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

/** What the card and the table row need. Narrower than the DTO, no secrets. */
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
  /** Whether artifacts written here are encrypted - true for every server
   *  destination, and for any bucket connected since buckets were encrypted. */
  encrypted: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  /** Bytes and artifact count this destination currently holds. */
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

/** What removing a destination destroys, so the dialog can name it. */
interface RemovalImpact {
  schedules: number;
  runs: number;
  artifacts: number;
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
export function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/**
 * Everything a destination can have done to it, in one place: the ⋯ menu, the
 * connection log, the removal confirm, and the test the card's refresh runs.
 * Rendered identically by the card and by the table row.
 */
export function useDestinationActions({
  dest,
  canManage,
}: {
  dest: DestinationCardView;
  /** `manage_backup_destinations`. Gates testing, the recovery key and removal. */
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
  // The row leaves the list on the click: the destination is dropped server-side
  // before any artifact sweeping starts, and that sweep can run for as long as
  // the bucket is big.
  const { hide, restore } = useOptimisticRow(dest.id);
  // What the removal takes with it, fetched when the dialog opens. Null while
  // unknown, so the copy never asserts a count it does not have.
  const [impact, setImpact] = React.useState<RemovalImpact | null>(null);
  const [alsoDeleteFiles, setAlsoDeleteFiles] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);
  const isServer = dest.kind === "server";
  const encrypted = dest.encrypted;

  /** Test the destination and say what actually happened. */
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
        // Repaint the badge and the free-space figure from the persisted verdict
        // either way.
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
        // The mutation itself failed (offline, not permitted, destination gone):
        // no verdict was recorded, so say only what we know.
        toast.error(e instanceof Error ? e.message : "The test could not run");
      }
    });
  }, [dest.id, dest.name, router]);

  /** Hand over the recovery key as a file (see `recovery-key.tsx`), then repaint
   *  so the nudge goes away. */
  const saveRecoveryKey = React.useCallback(() => {
    startTransition(async () => {
      if (await downloadRecoveryKey(dest.id)) router.refresh();
    });
  }, [dest.id, router]);

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
            // destinationTestReport declares the same capability the test does,
            // so without this the item is a click that ends in an authorization
            // error for a plain Member.
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
        // A re-run from inside the dialog repaints the badge too.
        onTested={() => router.refresh()}
      />

      {/**
       * The copy used to say backups "will stop running", which was not what
       * happened: the schedules and the whole run history are DELETED.
       */}
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={onConfirmOpenChange}
        title="Remove destination?"
        description={
          <span className="flex flex-col gap-2">
            <span>
              {impact && (impact.schedules > 0 || impact.runs > 0)
                ? `Removing ${dest.name} deletes ${plural(impact.schedules, "backup schedule")} and ${plural(impact.runs, "restore point")}. `
                : `Removing ${dest.name} deletes the backup schedules and restore points that use it. `}
              {alsoDeleteFiles
                ? "The backup files are deleted too."
                : isServer
                  ? "The backup files stay on the server."
                  : "Your bucket contents are not affected."}
              {/* The keypair goes with the row, so from here on those files can
                  only be opened by a recovery key someone already holds. */}
              {!alsoDeleteFiles &&
                encrypted &&
                " They are encrypted, and only the recovery key can read them once this destination is gone."}
            </span>
          </span>
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
        // Typed, like a restore. This deletes every schedule and the whole run
        // history, and with the box ticked the backup files as well - there is no
        // undo for any of it, and it used to be one click.
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

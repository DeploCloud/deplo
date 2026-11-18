"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  MessageSquareText,
  Pencil,
  Settings,
  Share2,
  Trash2,
  Unlink,
} from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bone } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RowActions } from "@/components/shared/row-actions";
import { TimeAgo } from "@/components/shared/time-ago";
import { EnvSelectBox } from "@/components/env/env-bulk-selection";
import {
  EnvValueCell,
  EnvValueUnderKey,
} from "@/components/env/env-value-cell";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { EnvEditButton } from "@/components/env/env-edit-button";
import { EnvListRow, EnvNotePanel } from "@/components/env/env-list";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { gqlAction } from "@/lib/graphql-client";
import { envNameLooksSensitive } from "@/lib/env-secret-name";
import type { EnvVarDTO } from "@/lib/types/env";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars/app-view";

export type EnvRow =
  ({ kind: "standalone" } & EnvVarDTO) | ({ kind: "shared" } & AppSharedVarDTO);

export const rowKey = (row: EnvRow) => `${row.kind}:${row.id}`;

function NoteMark({ note, open }: { note?: string | null; open: boolean }) {
  if (!note || open) return null;
  return (
    <MessageSquareText
      aria-label="Has a note"
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

export function StandaloneRow({
  row,
  open,
  onToggle,
  onEdit,
  onDelete,
}: {
  row: { kind: "standalone" } & EnvVarDTO;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const editLabel = row.connected
    ? "Rename"
    : row.type === "secret"
      ? "Edit note"
      : "Edit";
  return (
    <EnvListRow
      select={<EnvSelectBox id={rowKey(row)} />}
      open={open}
      onToggle={onToggle}
      keyCell={
        <>
          <div className="flex items-center gap-2">
            <VariableKey row={row} />
            <NoteMark note={row.note} open={open} />
            {row.type === "plain" &&
              !row.detectedDatabase &&
              envNameLooksSensitive(row.key) && <LooksLikeSecretBadge />}
            {row.database && !row.database.reachable && (
              <SimpleTooltip
                content={`This app cannot reach ${row.database.name}, so its next deploy fails until one of them moves.`}
              >
                <Badge
                  variant="outline"
                  className="text-[10px] font-normal whitespace-nowrap text-destructive"
                >
                  Unreachable
                </Badge>
              </SimpleTooltip>
            )}
          </div>
          <EnvValueUnderKey value={row.value} masked={row.masked} />
        </>
      }
      value={<EnvValueCell value={row.value} masked={row.masked} />}
      modified={<TimeAgo at={row.updatedAt} />}
      author={<EnvAuthorCell author={row.updatedBy ?? row.createdBy ?? null} />}
      actions={
        <RowActions
          title={row.key}
          actions={[
            row.connected && {
              label: "Unlink",
              icon: Unlink,
              onSelect: () =>
                void unlinkVariable(row.id, row.key, row.database?.name).then(
                  (ok) => ok && router.refresh(),
                ),
            },
            { label: editLabel, icon: Pencil, onSelect: onEdit },
            {
              label: "Delete",
              icon: Trash2,
              destructive: true,
              onSelect: onDelete,
            },
          ]}
        >
          <div className="flex justify-end gap-1">
            {row.connected && (
              <UnlinkButton
                id={row.id}
                envKey={row.key}
                database={row.database?.name}
              />
            )}
            <EnvEditButton
              secret={row.type === "secret" && !row.connected}
              label={row.connected ? "Rename" : "Edit"}
              onClick={onEdit}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              aria-label="Delete"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </RowActions>
      }
      panel={
        <EnvNotePanel
          note={row.note}
          action={
            !row.connected && (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 text-muted-foreground hover:text-foreground"
                onClick={onEdit}
              >
                <Pencil className="size-3.5" />
                {row.note ? "Edit note" : "Add note"}
              </Button>
            )
          }
        />
      }
    />
  );
}

export function SharedRow({
  row,
  open,
  onToggle,
  appId,
  editable,
  manageable,
  composeSetsIt,
  onRemoved,
  onRestored,
}: {
  row: { kind: "shared" } & AppSharedVarDTO;
  open: boolean;
  onToggle: () => void;
  appId: string;
  editable: boolean;
  manageable: boolean;
  composeSetsIt: boolean;
  onRemoved: () => void;
  onRestored: () => void;
}) {
  return (
    <EnvListRow
      select={<EnvSelectBox id={rowKey(row)} />}
      open={open}
      onToggle={onToggle}
      keyCell={
        <>
          <div className="flex items-center gap-2">
            {row.key}
            <NoteMark note={row.note} open={open} />
            <Badge
              variant="muted"
              className="gap-1 text-[10px] font-normal whitespace-nowrap"
            >
              <Share2 className="size-3" />
              {row.linked && editable
                ? "Shared"
                : (row.ownerTeamName ?? "Every team")}
            </Badge>
            {composeSetsIt && (
              <SimpleTooltip content="This app's compose file sets this variable itself, so the compose value is what the container gets.">
                <Badge
                  variant="outline"
                  className="text-[10px] font-normal whitespace-nowrap"
                >
                  Set in the compose file
                </Badge>
              </SimpleTooltip>
            )}
            {row.type === "plain" &&
              row.linked &&
              editable &&
              envNameLooksSensitive(row.key) && <LooksLikeSecretBadge />}
          </div>
          <EnvValueUnderKey value={row.value} masked={row.masked} />
        </>
      }
      value={<EnvValueCell value={row.value} masked={row.masked} />}
      modified={<TimeAgo at={row.updatedAt} />}
      author={<EnvAuthorCell author={row.updatedBy ?? null} />}
      actions={
        row.linked ? (
          <SharedRowActions
            row={row}
            appId={appId}
            manageable={manageable}
            onRemoved={onRemoved}
            onRestored={onRestored}
          />
        ) : (
          <SimpleTooltip
            content={`Shared by ${row.ownerTeamName ?? "an instance admin"}. Only they can change it.`}
          >
            <span className="text-xs text-muted-foreground">Read-only</span>
          </SimpleTooltip>
        )
      }
      panel={<EnvNotePanel note={row.note} />}
    />
  );
}

function SharedRowActions({
  row,
  appId,
  manageable,
  onRemoved,
  onRestored,
}: {
  row: AppSharedVarDTO;
  appId: string;
  manageable: boolean;
  onRemoved: () => void;
  onRestored: () => void;
}) {
  const router = useRouter();
  const keepsArriving = row.autoInject;

  function removeFromApp() {
    if (!keepsArriving) onRemoved();
    void (async () => {
      const res = await gqlAction(
        `mutation($varId: String!, $appId: String!, $linked: Boolean!) {
           setSharedVarAppLink(varId: $varId, appId: $appId, linked: $linked)
         }`,
        { varId: row.id, appId, linked: false },
      );
      if (res.ok) {
        toast.success(
          keepsArriving
            ? `${row.key} now arrives from ${row.ownerTeamName ?? "an instance admin"}`
            : `Removed ${row.key} from this app`,
        );
        router.refresh();
      } else {
        if (!keepsArriving) onRestored();
        toast.error(res.error);
      }
    })();
  }

  return (
    <RowActions
      title={row.key}
      actions={[
        manageable && {
          label: "Manage",
          icon: Settings,
          href: `/variables?tab=shared&edit=${row.id}`,
        },
        {
          label: "Remove from this app",
          icon: Unlink,
          destructive: true,
          onSelect: removeFromApp,
        },
      ]}
    >
      <div className="flex justify-end gap-1">
        {manageable && (
          <SimpleTooltip content="Manage this shared variable">
            <Button variant="ghost" size="icon-sm" asChild aria-label="Manage">
              <Link href={`/variables?tab=shared&edit=${row.id}`}>
                <Settings className="size-4" />
              </Link>
            </Button>
          </SimpleTooltip>
        )}
        <SimpleTooltip
          content={
            keepsArriving
              ? "Remove this app's opt-in. It still arrives from the team that shares it."
              : "Remove from this app. Every other app keeps it."
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={removeFromApp}
            aria-label="Remove from this app"
            className="text-muted-foreground hover:text-destructive"
          >
            <Unlink className="size-4" />
          </Button>
        </SimpleTooltip>
      </div>
    </RowActions>
  );
}

// The logo and the name both open the database a value comes from.
function VariableKey({ row }: { row: EnvVarDTO }) {
  const db = row.database ?? row.detectedDatabase;
  if (!db) return <>{row.key}</>;
  return (
    <SimpleTooltip
      content={row.database ? `Comes from ${db.name}` : `Points at ${db.name}`}
    >
      <Link
        href={`/storage/databases/${db.id}`}
        className="flex min-w-0 items-center gap-2 hover:underline"
      >
        <DatabaseLogo type={db.type} logo={db.logo} size={18} />
        {row.key}
      </Link>
    </SimpleTooltip>
  );
}

// Unlink keeps today's value and stops following; Delete stays its own action.
async function unlinkVariable(
  id: string,
  envKey: string,
  database?: string,
): Promise<boolean> {
  const res = await gqlAction(
    /* GraphQL */ `
      mutation ($id: String!) {
        unlinkEnv(id: $id) {
          id
        }
      }
    `,
    { id },
  );
  if (!res.ok) {
    toast.error(res.error);
    return false;
  }
  toast.success(`${envKey} no longer follows ${database ?? "its database"}`, {
    description: "It keeps its current value.",
  });
  return true;
}

function UnlinkButton({
  id,
  envKey,
  database,
}: {
  id: string;
  envKey: string;
  database?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <SimpleTooltip content="Unlink">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending}
        aria-label="Unlink"
        onClick={() =>
          startTransition(async () => {
            if (await unlinkVariable(id, envKey, database)) router.refresh();
          })
        }
      >
        <Unlink className="size-4" />
      </Button>
    </SimpleTooltip>
  );
}

function LooksLikeSecretBadge() {
  return (
    <InfoTip
      tone="warning"
      label="This name usually holds a credential"
      className="size-4"
      content="This name usually holds a credential. Edit it and turn on Secret: the value is then write-only and nothing shows it again."
    />
  );
}

export const PLACEHOLDER_KEYS = ["DATABASE_URL", "API_KEY", "NODE_ENV"];

const PLACEHOLDER_AUTHOR = {
  id: "loading",
  name: "Someone",
  username: "someone",
  avatarColor: "",
  avatarUrl: null,
};

// What a typical App's variables offer the filters: both types, one editor.
export const PLACEHOLDER_FACET_ROWS = (["plain", "secret"] as const).map(
  (type) =>
    ({
      type,
      kind: "standalone",
      updatedBy: PLACEHOLDER_AUTHOR,
    }) as unknown as EnvRow,
);

const PLACEHOLDER_ACTIONS = [
  { label: "Edit", icon: Pencil, disabled: true },
  { label: "Delete", icon: Trash2, destructive: true, disabled: true },
];

// A variable's row while the tab loads: its real cells, the values boned.
export function EnvRowSkeleton({ envKey }: { envKey: string }) {
  return (
    <EnvListRow
      select={<EnvSelectBox id={envKey} />}
      open={false}
      onToggle={() => {}}
      keyCell={
        <>
          <Bone>{envKey}</Bone>
          <Bone box className="w-full md:hidden">
            <EnvValueUnderKey value="" masked />
          </Bone>
        </>
      }
      value={
        <Bone box className="w-full">
          <EnvValueCell value="" masked />
        </Bone>
      }
      modified={<Bone>2 months ago</Bone>}
      author={
        <Bone box>
          <EnvAuthorCell author={PLACEHOLDER_AUTHOR} />
        </Bone>
      }
      actions={
        <RowActions title={envKey} actions={PLACEHOLDER_ACTIONS}>
          <div className="flex justify-end gap-1">
            {[Pencil, Trash2].map((Icon, i) => (
              <Bone box key={i}>
                <Button variant="ghost" size="icon-sm" disabled>
                  <Icon className="size-4" />
                </Button>
              </Bone>
            ))}
          </div>
        </RowActions>
      }
      panel={null}
    />
  );
}

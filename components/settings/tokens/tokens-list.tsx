"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import {
  Trash2,
  ShieldAlert,
  FolderTree,
  ServerCog,
  Bot,
  Pencil,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Bone } from "@/components/ui/skeleton";
import { ALL_CAPABILITIES } from "@/lib/types/identity";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RowActions } from "@/components/shared/row-actions";
import { ROW_ACTIONS_CELL } from "@/components/shared/row-actions-cell";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import {
  TOKEN_PRESET_ICON,
  CUSTOM_TOKEN_ICON,
} from "@/components/settings/tokens/new-token-menu";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import { CAPABILITY_META } from "@/lib/capabilities";
import { TOKEN_PRESETS, presetIdFor } from "@/lib/token-presets";
import { scopeLabel } from "@/components/settings/tokens/scope-label";
import { revokeDescription } from "@/components/settings/tokens/revoke-copy";
import type { ApiTokenDTO } from "@/lib/data/tokens/listing";

export function TokensList({
  tokens,
  names,
  activeTeamId,
  loading = false,
}: {
  loading?: boolean;
  tokens: ApiTokenDTO[];
  names: Record<string, string>;
  activeTeamId: string;
}) {
  const router = useRouter();
  const [revoke, setRevoke] = React.useState<ApiTokenDTO | null>(null);
  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(tokens, (t) => t.id);
  const copyFor = (t: ApiTokenDTO) => ({
    teams: t.teamsReached,
    activeTeamId,
    scoped: t.scoped,
  });

  return (
    <div className="rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Permissions</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-right">
              <span className="max-md:sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody inert={loading || undefined}>
          {rows.map((t) => {
            const presetId = presetIdFor(t.capabilities);
            const preset = TOKEN_PRESETS.find((p) => p.id === presetId);
            const Icon = presetId
              ? TOKEN_PRESET_ICON[presetId]
              : CUSTOM_TOKEN_ICON;
            const granted = t.capabilities.filter((c) => c !== "view").length;
            const sensitive = t.capabilities.some(
              (c) => CAPABILITY_META[c]?.sensitive,
            );
            const scope = scopeLabel(t, names);
            return (
              <TableRow key={t.id}>
                <TableCell>
                  <Bone loading={loading}>
                    <Link
                      href={`/settings/tokens/${t.id}`}
                      className="font-medium hover:underline"
                    >
                      {t.name}
                    </Link>
                  </Bone>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    <Bone loading={loading}>
                      {`${t.prefix}${"•".repeat(8)}`}
                    </Bone>
                  </p>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Bone box loading={loading}>
                      <Badge variant="secondary" className="gap-1">
                        <Icon className="size-3" aria-hidden />
                        {preset
                          ? preset.name
                          : granted === 0
                            ? "View only"
                            : `${granted} permissions`}
                      </Badge>
                    </Bone>
                    {sensitive && (
                      <SimpleTooltip content="Holds a permission that can destroy data or hand over access">
                        <span className="leading-none">
                          <ShieldAlert
                            className="size-3.5 text-amber-500"
                            aria-label="Sensitive permission"
                          />
                        </span>
                      </SimpleTooltip>
                    )}
                    {t.instanceAdmin && (
                      <Badge variant="outline" className="gap-1">
                        <ServerCog className="size-3" aria-hidden />
                        Instance admin
                      </Badge>
                    )}
                    {t.mcp && (
                      <SimpleTooltip
                        content={
                          t.oauthClientName
                            ? "An AI client connected over OAuth. Edit or revoke it here."
                            : "This token drives an AI agent over MCP. Edit or revoke it here."
                        }
                      >
                        <Badge variant="outline" className="max-w-40 gap-1">
                          <Bot className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">
                            {t.oauthClientName ?? "MCP"}
                          </span>
                        </Badge>
                      </SimpleTooltip>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {loading ? (
                    <Bone>{scope.text}</Bone>
                  ) : !t.scoped ? (
                    scope.text
                  ) : scope.empty ? (
                    <SimpleTooltip content="Every team, project and app it was limited to has been deleted, so it reaches nothing and no longer authenticates. Edit it to pick another, or revoke it.">
                      <span className="flex w-fit items-center gap-1 text-amber-500">
                        <FolderTree className="size-3.5" aria-hidden />
                        {scope.text}
                      </span>
                    </SimpleTooltip>
                  ) : (
                    <span className="flex w-fit items-center gap-1">
                      <FolderTree className="size-3.5" aria-hidden />
                      {scope.text}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <Bone loading={loading}>
                    {t.lastUsedAt ? timeAgo(t.lastUsedAt) : "Never used"}
                  </Bone>
                  {t.expiresAt &&
                    (t.expired ? (
                      <SimpleTooltip content="This token has expired and no longer authenticates anywhere. Edit it to move the date, or revoke it.">
                        <span className="mt-1 block w-fit text-xs text-amber-500">
                          Expired {timeAgo(t.expiresAt)}
                        </span>
                      </SimpleTooltip>
                    ) : (
                      <span className="mt-1 block text-xs">
                        <Bone loading={loading}>
                          Expires {new Date(t.expiresAt).toLocaleDateString()}
                        </Bone>
                      </span>
                    ))}
                </TableCell>
                <TableCell className={`text-right ${ROW_ACTIONS_CELL}`}>
                  <RowActions
                    title={t.name}
                    actions={[
                      {
                        label: "Edit",
                        icon: Pencil,
                        href: `/settings/tokens/${t.id}`,
                      },
                      {
                        label: "Revoke",
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => setRevoke(t),
                      },
                    ]}
                  >
                    <div className="flex justify-end gap-1">
                      <Button asChild variant="ghost" size="icon-sm">
                        <Link
                          href={`/settings/tokens/${t.id}`}
                          aria-label={`Edit ${t.name}`}
                        >
                          <Pencil className="size-4" />
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setRevoke(t)}
                        aria-label={`Revoke ${t.name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </RowActions>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <ConfirmAction
        open={revoke !== null}
        onOpenChange={(v) => !v && setRevoke(null)}
        title="Revoke token?"
        description={
          revoke ? (
            <>
              <strong>{revoke.name}</strong> is deleted.
            </>
          ) : (
            "The token is deleted."
          )
        }
        consequence={revoke ? revokeDescription(copyFor(revoke)) : undefined}
        confirmLabel="Revoke token"
        successMessage="Token revoked"
        optimistic
        onConfirm={async () => {
          const id = revoke!.id;
          remove(id);
          const res = await gqlAction(
            `mutation($id: String!) { revokeToken(id: $id) }`,
            { id },
          );
          if (!res.ok) restore(id);
          router.refresh();
          return res;
        }}
      />
    </div>
  );
}

const SKELETON_TOKENS: ApiTokenDTO[] = [
  "Claude Code",
  "GitHub Actions deploy",
  "Codex CLI",
].map((name, i) => ({
  id: String(i),
  name,
  prefix: "deplo_ab12cd",
  capabilities: ALL_CAPABILITIES.slice(0, 44),
  scoped: false,
  teamIds: [],
  projectIds: [],
  folderIds: [],
  appIds: [],
  teamsReached: [],
  instanceAdmin: false,
  oauthClientName: null,
  mcp: i !== 1,
  expiresAt: "2026-12-04T00:00:00.000Z",
  expired: false,
  lastUsedAt: null,
  createdAt: "",
}));

export function TokensListSkeleton() {
  return (
    <TokensList tokens={SKELETON_TOKENS} names={{}} activeTeamId="" loading />
  );
}

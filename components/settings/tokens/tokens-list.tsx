"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2, ShieldAlert, FolderTree, ServerCog } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  TOKEN_PRESET_ICON,
  CUSTOM_TOKEN_ICON,
} from "@/components/settings/tokens/new-token-menu";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import { CAPABILITY_META } from "@/lib/capabilities";
import { TOKEN_PRESETS, presetIdFor } from "@/lib/token-presets";
import { scopeLabel } from "@/components/settings/tokens/scope-label";
import type { ApiTokenDTO } from "@/lib/data/tokens";

/**
 * The team's API tokens. A LIST, not a master-detail rail: nobody compares two
 * tokens side by side, and what you actually do here is scan metadata — how much
 * power, over what, last used when. That is columns. It also leaves the editor
 * the full page width, which is what forty permission checkboxes need.
 */
export function TokensList({
  tokens,
  names,
  canManage,
}: {
  tokens: ApiTokenDTO[];
  /** Team / project / app id → name, as far as this team can resolve them. */
  names: Record<string, string>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [revoke, setRevoke] = React.useState<ApiTokenDTO | null>(null);

  return (
    <div className="rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Permissions</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Created by</TableHead>
            {canManage && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((t) => {
            const presetId = presetIdFor(t.capabilities);
            const preset = TOKEN_PRESETS.find((p) => p.id === presetId);
            const Icon = presetId ? TOKEN_PRESET_ICON[presetId] : CUSTOM_TOKEN_ICON;
            const granted = t.capabilities.filter((c) => c !== "view").length;
            const sensitive = t.capabilities.some(
              (c) => CAPABILITY_META[c]?.sensitive,
            );
            const scope = scopeLabel(t, names);
            return (
              <TableRow key={t.id}>
                <TableCell>
                  <Link
                    href={`/settings/tokens/${t.id}`}
                    className="font-medium hover:underline"
                  >
                    {t.name}
                  </Link>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {`${t.prefix}${"•".repeat(8)}`}
                  </p>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="gap-1">
                      <Icon className="size-3" aria-hidden />
                      {preset
                        ? preset.name
                        : granted === 0
                          ? "View only"
                          : `${granted} permissions`}
                    </Badge>
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
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {!t.scoped ? (
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
                  {t.lastUsedAt ? timeAgo(t.lastUsedAt) : "Never used"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {t.createdByUsername ?? "—"}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setRevoke(t)}
                      aria-label={`Revoke ${t.name}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <ConfirmAction
        open={revoke !== null}
        onOpenChange={(v) => !v && setRevoke(null)}
        title={revoke ? `Revoke ${revoke.name}?` : "Revoke this token?"}
        description="Every client using it loses access immediately, including any deploy hook that sends it. This can't be undone; create a new token if you still need one."
        confirmLabel="Revoke token"
        successMessage="Token revoked"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { revokeToken(id: $id) }`,
            { id: revoke!.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

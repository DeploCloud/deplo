"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Plus,
  KeyRound,
  FileText,
  ShieldAlert,
  FolderTree,
  Eye,
  Rocket,
  Bot,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CAPABILITY_META } from "@/lib/capabilities";
import { TOKEN_PRESETS, presetIdFor, type TokenPresetId } from "@/lib/token-presets";
import type { ApiTokenDTO } from "@/lib/data/tokens";

/** Marks for the shipped templates. Data stays in `lib/token-presets.ts`. */
export const TOKEN_PRESET_ICON: Record<TokenPresetId, LucideIcon> = {
  readonly: Eye,
  ci: Rocket,
  mcp: Bot,
  automation: Workflow,
  root: ShieldAlert,
};

/**
 * The team's API tokens, as the left rail of the tokens pages: pick one to see
 * or change what it can do, or mint a new one.
 *
 * "New token" is a menu rather than a button for the same reason the roles rail
 * uses one: the first decision is what the token is FOR, and answering it up
 * front is what keeps a "start from" field out of the editor. The difference is
 * that these templates are ours and are not editable — there is no "start from
 * another token", because reading one credential's power to author another is
 * not a thing a permissions screen should teach.
 */
export function TokensRail({
  tokens,
  canManage,
}: {
  tokens: ApiTokenDTO[];
  canManage: boolean;
}) {
  const router = useRouter();
  // Which entry is open comes from the URL rather than a prop, so the rail can
  // live in the layout and survive navigation between tokens.
  const pathname = usePathname();
  const activeId = pathname.startsWith("/settings/tokens/")
    ? pathname.slice("/settings/tokens/".length).split("/")[0]
    : null;

  return (
    <div className="space-y-2 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tokens
          <span className="ml-1.5 tabular-nums text-muted-foreground/70">
            {tokens.length}
          </span>
        </h2>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="size-4" />
                New token
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => router.push("/settings/tokens/new")}
              >
                <FileText className="size-4" />
                <span className="flex flex-col">
                  <span>Start from scratch</span>
                  <span className="text-xs text-muted-foreground">
                    View access only, then pick what to add
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Start from a template</DropdownMenuLabel>
              {TOKEN_PRESETS.map((p) => {
                const Icon = TOKEN_PRESET_ICON[p.id];
                return (
                  <DropdownMenuItem
                    key={p.id}
                    className="cursor-pointer"
                    onSelect={() =>
                      router.push(`/settings/tokens/new?preset=${p.id}`)
                    }
                  >
                    <Icon className="size-4" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{p.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.description}
                      </span>
                    </span>
                    <span className="shrink-0 self-start tabular-nums text-xs text-muted-foreground">
                      {p.capabilities.filter((c) => c !== "view").length}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <nav className="space-y-1">
        {tokens.map((token) => {
          const preset = presetIdFor(token.capabilities);
          const Icon = preset ? TOKEN_PRESET_ICON[preset] : KeyRound;
          const active = token.id === activeId;
          const granted = token.capabilities.filter((c) => c !== "view").length;
          const sensitive = token.capabilities.some(
            (c) => CAPABILITY_META[c]?.sensitive,
          );
          return (
            <Link
              key={token.id}
              href={`/settings/tokens/${token.id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                active
                  ? "border-primary bg-primary/5"
                  : "border-transparent hover:bg-accent",
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-md",
                  token.instanceAdmin
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : active
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {token.name}
                  </span>
                  {sensitive && (
                    <SimpleTooltip content="Holds a permission that can destroy data or hand over access">
                      <span className="leading-none">
                        <ShieldAlert
                          className="size-3 shrink-0 text-amber-500"
                          aria-label="Sensitive permission"
                        />
                      </span>
                    </SimpleTooltip>
                  )}
                  {token.projectScoped && (
                    <SimpleTooltip content="Limited to specific projects">
                      <span className="leading-none">
                        <FolderTree
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-label="Limited to projects"
                        />
                      </span>
                    </SimpleTooltip>
                  )}
                </span>
                <span className="block truncate text-xs tabular-nums text-muted-foreground">
                  {granted === 0 ? "View only" : `${granted} permissions`}
                  {" · "}
                  {token.prefix}
                </span>
              </span>
              {token.instanceAdmin && (
                <Badge variant="outline" className="shrink-0">
                  Admin
                </Badge>
              )}
            </Link>
          );
        })}

        {activeId === "new" && (
          <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-primary bg-primary/5 px-2.5 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Plus className="size-3.5" aria-hidden />
            </span>
            <span className="text-sm font-medium">New token</span>
          </div>
        )}
      </nav>
    </div>
  );
}

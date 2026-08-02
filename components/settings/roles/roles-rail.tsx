"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Plus,
  Crown,
  UserCog,
  Eye,
  Shield,
  Lock,
  FileText,
  Copy,
  Fingerprint,
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
import type { TeamRoleDTO } from "@/lib/data/roles";

const ROLE_ICON: Record<string, LucideIcon> = {
  owner: Crown,
  member: UserCog,
  viewer: Eye,
};

/**
 * The roles of the team, as the left rail of the roles pages: pick one to edit
 * it, or start a new one.
 *
 * "New role" is a menu rather than a button because the first decision is what
 * the role starts as — an empty one, or a copy of a role that already exists.
 * Asking that up front is what removes the "start from" field from the editor:
 * by the time the form opens, the answer is already in it.
 */
export function RolesRail({
  roles,
  canManage,
}: {
  roles: TeamRoleDTO[];
  canManage: boolean;
}) {
  const router = useRouter();
  // Which entry is open comes from the URL rather than a prop, so the rail can
  // live in the layout and survive navigation between roles without re-rendering
  // the whole page from the server.
  const pathname = usePathname();
  const activeId = pathname.startsWith("/settings/roles/")
    ? pathname.slice("/settings/roles/".length).split("/")[0]
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Roles
          <span className="ml-1.5 tabular-nums text-muted-foreground/70">
            {roles.length}
          </span>
        </h2>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="size-4" />
                New role
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => router.push("/settings/roles/new")}
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
              <DropdownMenuLabel>Start from an existing role</DropdownMenuLabel>
              {roles.map((r) => (
                <DropdownMenuItem
                  key={r.id}
                  className="cursor-pointer"
                  onSelect={() => router.push(`/settings/roles/new?from=${r.id}`)}
                >
                  <Copy className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {r.capabilities.filter((c) => c !== "view").length}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <nav className="space-y-1">
        {roles.map((role) => {
          const Icon = role.builtinKey ? ROLE_ICON[role.builtinKey] : Shield;
          const active = role.id === activeId;
          const granted = role.capabilities.filter((c) => c !== "view").length;
          return (
            <Link
              key={role.id}
              href={`/settings/roles/${role.id}`}
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
                  role.builtinKey === "owner"
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
                  <span className="truncate text-sm font-medium">{role.name}</span>
                  {role.locked && (
                    <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Locked" />
                  )}
                  {role.requireTwoFactor && (
                    <SimpleTooltip content="Holders must have two-factor authentication">
                      <span className="leading-none">
                        <Fingerprint
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-label="Two-factor required"
                        />
                      </span>
                    </SimpleTooltip>
                  )}
                </span>
                <span className="block truncate text-xs tabular-nums text-muted-foreground">
                  {granted === 0 ? "View only" : `${granted} permissions`}
                  {role.memberCount > 0 &&
                    ` · ${role.memberCount} member${role.memberCount === 1 ? "" : "s"}`}
                </span>
              </span>
              {role.modified && !role.locked && (
                <Badge variant="outline" className="shrink-0">
                  Edited
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
            <span className="text-sm font-medium">New role</span>
          </div>
        )}
      </nav>
    </div>
  );
}

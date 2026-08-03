"use client";

import * as React from "react";
import Link from "next/link";
import {
  Crown,
  UserCog,
  Eye,
  Shield,
  SlidersHorizontal,
  Check,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import type { TeamRoleDTO } from "@/lib/data/roles";

const ROLE_ICON: Record<string, LucideIcon> = {
  owner: Crown,
  member: UserCog,
  viewer: Eye,
};

/**
 * Pick the role a member holds. One decision, not a capability grid: what a role
 * grants is defined once in Settings → Team → Roles and shown here as the summary
 * line + permission count, so the same set can't drift member by member.
 *
 * A member who predates roles (or was granted a one-off capability by an account
 * deletion healing the team) holds a hand-picked "Custom" set. That state is shown
 * as its own row so it reads as a real state, and picking any role replaces it.
 */
export function RoleSelect({
  roles,
  value,
  onChange,
  canAssignOwner = false,
  isCustom = false,
}: {
  roles: TeamRoleDTO[];
  value: string | null;
  onChange: (roleId: string) => void;
  /** Offer the Owner role. Only an owner may hand out the owner rank. */
  canAssignOwner?: boolean;
  /** The member currently holds a hand-picked set that belongs to no role. */
  isCustom?: boolean;
}) {
  const visible = roles.filter(
    (r) => canAssignOwner || r.builtinKey !== "owner",
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium">Role</h3>
          <InfoTip content="What this member can do in the team. Roles are defined once for the whole team — editing one updates every member who holds it." />
        </div>
        <Link
          href="/settings/roles"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings2 className="size-3" aria-hidden />
          Manage roles
        </Link>
      </div>

      <div role="group" aria-label="Role" className="space-y-1.5">
        {isCustom && value === null && (
          <div className="flex w-full items-center gap-3 rounded-lg border border-primary bg-primary/5 px-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <SlidersHorizontal className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Custom</span>
              <span className="mt-1 block text-xs leading-snug text-muted-foreground">
                A hand-picked set of permissions. Pick a role to replace it.
              </span>
            </span>
            <Check className="size-4 shrink-0 text-primary" aria-hidden />
          </div>
        )}

        {visible.map((role) => {
          const Icon = role.builtinKey ? ROLE_ICON[role.builtinKey] : Shield;
          const selected = role.id === value;
          const optional = role.capabilities.filter((c) => c !== "view").length;
          return (
            <button
              key={role.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(role.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent",
              )}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md",
                  selected
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">{role.name}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {optional === 0
                      ? "View only"
                      : `${optional} permission${optional === 1 ? "" : "s"}`}
                  </span>
                </span>
                {role.description && (
                  <span className="block truncate text-xs leading-snug text-muted-foreground">
                    {role.description}
                  </span>
                )}
              </span>
              {selected && (
                <Check className="size-4 shrink-0 text-primary" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

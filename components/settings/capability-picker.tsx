"use client";

import * as React from "react";
import {
  Crown,
  UserCog,
  Eye,
  SlidersHorizontal,
  Rocket,
  Database,
  Users,
  Check,
  Lock,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import { ALL_CAPABILITIES, type Capability, type Role } from "@/lib/types";
import {
  CAPABILITY_META,
  CAPABILITY_PRESETS,
  roleLabelForCapabilities,
} from "@/lib/membership-shared";

type RoleLabel = Role | "custom";

/** Role presets, rendered as the top-tier "starting point" rows. */
const ROLE_META: Record<
  RoleLabel,
  { label: string; description: string; icon: LucideIcon }
> = {
  owner: {
    label: "Owner",
    description: "Full control of the team and everything in it.",
    icon: Crown,
  },
  member: {
    label: "Member",
    description: "Deploy and manage apps, domains, variables and files.",
    icon: UserCog,
  },
  viewer: {
    label: "Viewer",
    description: "Read-only access across the whole team.",
    icon: Eye,
  },
  custom: {
    label: "Custom",
    description: "A hand-picked set of capabilities.",
    icon: SlidersHorizontal,
  },
};

/** Canonical preset order for the selector. */
const ROLE_ORDER: Role[] = ["owner", "member", "viewer"];

/**
 * Every non-`view` capability belongs to exactly one section. `view` is the
 * always-on floor and is rendered as a locked chip above these sections, never
 * as a toggle. The order here drives the fine-tune card top-to-bottom.
 */
const SECTIONS: { title: string; icon: LucideIcon; caps: Capability[] }[] = [
  {
    title: "Apps & configuration",
    icon: Rocket,
    caps: ["deploy", "manage_domains", "manage_env", "manage_files"],
  },
  { title: "Infrastructure", icon: Database, caps: ["manage_infra"] },
  {
    title: "Team administration",
    icon: Users,
    caps: ["manage_members", "manage_team"],
  },
];

/** Optional capabilities = everything except the always-on `view` floor. */
const OPTIONAL_COUNT = ALL_CAPABILITIES.length - 1;

/** Badge tone for the effective-access read-back, by resolved label. */
const SUMMARY_BADGE: Record<RoleLabel, BadgeProps["variant"]> = {
  owner: "default",
  member: "secondary",
  viewer: "muted",
  custom: "outline",
};

/**
 * Role + per-capability picker shared by the invite, create-user and edit-member
 * flows. It presents the decision as the two questions a manager actually asks —
 * "what kind of member is this?" (a preset row) and "anything to fine-tune?"
 * (the grouped capability card) — instead of a flat checkbox grid.
 *
 * The ticked capability set is the single source of truth for the highlight:
 * picking a preset applies its exact set, and toggling any one capability flips
 * the selector to a live "Custom" state (with a one-click Reset back to the last
 * preset). `view` is the always-on floor — shown locked, never removable.
 *
 * The prop contract is unchanged from the previous picker, so no caller edits are
 * needed. `availableRoles` restricts which presets are offered (e.g. hide "owner"
 * for a plain manager); a set that matches a hidden preset still reads as Custom.
 */
export function CapabilityPicker({
  role,
  capabilities,
  onRoleChange,
  onCapabilitiesChange,
  idPrefix = "cap",
  availableRoles,
}: {
  role: Role;
  capabilities: Capability[];
  onRoleChange: (role: Role) => void;
  onCapabilitiesChange: (caps: Capability[]) => void;
  idPrefix?: string;
  /** Restrict the selectable roles (e.g. omit "owner" when adding a member). */
  availableRoles?: Role[];
}) {
  const enabled = React.useMemo(() => new Set(capabilities), [capabilities]);
  const visibleRoles = ROLE_ORDER.filter(
    (r) => !availableRoles || availableRoles.includes(r),
  );

  // Highlight + Custom detection derive from the ticked SET, not the `role`
  // prop — so unticking a single box flips to Custom instantly. `role` is only
  // the last preset explicitly picked, kept as the label/default and the Reset
  // target. A set matching an off-menu preset (e.g. the owner set while owner is
  // hidden) also reads as Custom rather than silently highlighting nothing.
  const activeLabel = roleLabelForCapabilities(capabilities);
  const isCustom =
    activeLabel === "custom" || !visibleRoles.includes(activeLabel as Role);
  const resolved: RoleLabel = isCustom ? "custom" : (activeLabel as Role);
  const enabledOptional = capabilities.filter((c) => c !== "view").length;
  const resetTarget: Role = visibleRoles.includes(role)
    ? role
    : (visibleRoles[0] ?? "viewer");

  function pickRole(next: Role) {
    onRoleChange(next);
    onCapabilitiesChange([...CAPABILITY_PRESETS[next]]);
  }

  function toggle(cap: Capability, on: boolean) {
    if (cap === "view") return; // always-on floor
    const set = new Set(capabilities);
    if (on) set.add(cap);
    else set.delete(cap);
    set.add("view");
    onCapabilitiesChange(ALL_CAPABILITIES.filter((c) => set.has(c)));
  }

  return (
    <div className="space-y-5">
      {/* ---- Tier 1: pick a role preset ---- */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium">Role</h3>
          <InfoTip content="A role is a preset over the capabilities below. Pick one to start, then fine-tune — view access is always on." />
        </div>

        <div role="group" aria-label="Role preset" className="space-y-1.5">
          {visibleRoles.map((r) => {
            const meta = ROLE_META[r];
            const Icon = meta.icon;
            const selected = !isCustom && activeLabel === r;
            return (
              <button
                key={r}
                type="button"
                aria-pressed={selected}
                onClick={() => pickRole(r)}
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
                    <span className="text-sm font-medium">{meta.label}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {CAPABILITY_PRESETS[r].length}/{ALL_CAPABILITIES.length}
                    </span>
                  </span>
                  <span className="block text-xs leading-snug text-muted-foreground">
                    {meta.description}
                  </span>
                </span>
                {selected && (
                  <Check
                    className="size-4 shrink-0 text-primary"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}

          {/* Custom is live-detected — it reflects the ticked set, it is not a
              click target (onRoleChange can never carry "custom"). */}
          {isCustom && (
            <div
              aria-label="Custom capability set — active"
              className="flex w-full items-center gap-3 rounded-lg border border-primary bg-primary/5 px-3 py-2.5"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <SlidersHorizontal className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {ROLE_META.custom.label}
                </span>
                <span className="block text-xs leading-snug text-muted-foreground">
                  {ROLE_META.custom.description}
                </span>
              </span>
              <Check className="size-4 shrink-0 text-primary" aria-hidden />
            </div>
          )}
        </div>
      </section>

      {/* ---- Tier 2: fine-tune the exact capabilities ---- */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium">Capabilities</h3>
          <InfoTip content="Start from a role, then tick or untick individual capabilities. View access is always on and can't be removed." />
        </div>

        <div className="overflow-hidden rounded-lg border border-border">
          {/* Preset-match state + the reversible Reset escape hatch. */}
          <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
            <span className="text-xs text-muted-foreground">
              {isCustom
                ? "Custom set"
                : `Matches the ${ROLE_META[resolved].label} preset`}
            </span>
            {isCustom && (
              <button
                type="button"
                onClick={() => pickRole(resetTarget)}
                className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw className="size-3" aria-hidden />
                Reset to {ROLE_META[resetTarget].label}
              </button>
            )}
          </div>

          <div className="space-y-3 p-3">
            {/* view — the locked, always-granted floor (never a checkbox). */}
            <div
              className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground"
              aria-label={`View — always granted and can't be removed. ${CAPABILITY_META.view.description}`}
            >
              <Lock className="size-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium text-foreground/80">
                  {CAPABILITY_META.view.label}
                </span>
                {" — always granted. "}
                {CAPABILITY_META.view.description}
              </span>
            </div>

            {SECTIONS.map((sec) => {
              const SecIcon = sec.icon;
              const granted = sec.caps.filter((c) => enabled.has(c)).length;
              return (
                <div key={sec.title} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 pt-1">
                    <SecIcon
                      className="size-3.5 text-muted-foreground"
                      aria-hidden
                    />
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {sec.title}
                    </h4>
                    <Badge
                      variant={granted === 0 ? "muted" : "secondary"}
                      className="ml-auto tabular-nums"
                    >
                      {granted}/{sec.caps.length}
                    </Badge>
                  </div>
                  {sec.caps.map((cap) => {
                    const meta = CAPABILITY_META[cap];
                    const id = `${idPrefix}-${cap}`;
                    return (
                      <label
                        key={cap}
                        htmlFor={id}
                        className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
                      >
                        <Checkbox
                          id={id}
                          checked={enabled.has(cap)}
                          onCheckedChange={(v) => toggle(cap, v === true)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium leading-tight">
                            {meta.label}
                          </span>
                          <span className="block text-xs leading-snug text-muted-foreground">
                            {meta.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Live effective-access read-back. */}
        <div
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-0.5"
        >
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Effective access
            <Badge variant={SUMMARY_BADGE[resolved]}>
              {isCustom && <SlidersHorizontal className="size-3" aria-hidden />}
              {ROLE_META[resolved].label}
            </Badge>
          </span>
          <span className="text-xs font-medium tabular-nums text-muted-foreground">
            {enabledOptional} of {OPTIONAL_COUNT} extra capabilities
          </span>
        </div>
      </section>
    </div>
  );
}

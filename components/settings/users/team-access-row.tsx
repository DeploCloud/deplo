"use client";

import * as React from "react";
import { Crown, Trash2 } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { PermissionPicker } from "@/components/settings/permission-picker";
import {
  ScopePicker,
  type ScopeNode,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { NODE_GRANTABLE_CAPABILITIES } from "@/lib/membership-shared";
import { cn } from "@/lib/utils";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { TeamRoleOption, UserTeamAccessDTO } from "@/lib/data/user-access";
import type { Capability } from "@/lib/types";

/** A node key that survives across renders: kind and id, never the object. */
export type NodeKey = `${ScopeNode["kind"]}:${string}`;

/** The editable state of one team block, lifted so the page owns Save. */
export interface TeamAccessDraft {
  roleId: string;
  granular: boolean;
  selection: ScopeSelection;
  /** One set for everything ticked. */
  shared: Capability[];
  /** Per-node overrides of {@link shared}, when `uniform` is off. */
  perNode: Record<NodeKey, Capability[]>;
  uniform: boolean;
}

/** The draft a saved team starts from. */
export function draftFor(access: UserTeamAccessDTO): TeamAccessDraft {
  const selection: ScopeSelection = {
    teamIds: [],
    projectIds: access.nodes.filter((n) => n.kind === "project").map((n) => n.nodeId),
    folderIds: access.nodes.filter((n) => n.kind === "folder").map((n) => n.nodeId),
    appIds: access.nodes.filter((n) => n.kind === "app").map((n) => n.nodeId),
  };
  const perNode: Record<NodeKey, Capability[]> = {};
  for (const n of access.nodes) {
    perNode[`${n.kind}:${n.nodeId}` as NodeKey] = n.capabilities;
  }
  // Every node holding the same set is what "uniform" means, and it is how the
  // save writes them, so a round trip must not silently flip the switch off.
  const sets = access.nodes.map((n) => [...n.capabilities].sort().join(","));
  const uniform = sets.length === 0 || sets.every((s) => s === sets[0]);
  return {
    roleId: access.roleId ?? "",
    granular: access.granular,
    selection,
    shared: uniform && access.nodes[0] ? access.nodes[0].capabilities : ["view"],
    perNode,
    uniform,
  };
}

/** Every node the selection covers, in the order the tree draws them. */
function selectedKeys(selection: ScopeSelection): NodeKey[] {
  return [
    ...selection.projectIds.map((id) => `project:${id}` as NodeKey),
    ...selection.folderIds.map((id) => `folder:${id}` as NodeKey),
    ...selection.appIds.map((id) => `app:${id}` as NodeKey),
  ];
}

/**
 * One team's block on a person's account page: which role they hold there and,
 * optionally, the projects, folders and apps where a different set applies.
 *
 * The two modes are not alternatives to each other — granular is the role PLUS
 * overrides, which is why the role stays on screen in both. Inside a ticked node
 * the override REPLACES the role's set and may grant more than it does, and the
 * sentence under the tree says exactly that.
 */
export function TeamAccessRow({
  access,
  roles,
  tree,
  draft,
  onChange,
  onRemove,
  disabled,
}: {
  access: UserTeamAccessDTO;
  roles: TeamRoleOption[];
  /** The scope tree of THIS team only — a one-element array of the picker's. */
  tree: ScopeTreeTeam | undefined;
  draft: TeamAccessDraft;
  onChange: (next: TeamAccessDraft) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const [focus, setFocus] = React.useState<NodeKey | null>(null);
  const names = React.useMemo(() => namesInTree(tree), [tree]);
  const keys = selectedKeys(draft.selection);
  const locked = disabled || access.isFounder;

  // The focused node is whatever is still ticked; a node that gets unticked
  // shouldn't leave the picker editing a set nobody can see.
  const active = focus && keys.includes(focus) ? focus : (keys[0] ?? null);

  const capsOf = (key: NodeKey): Capability[] =>
    draft.uniform ? draft.shared : (draft.perNode[key] ?? draft.shared);

  function setCaps(next: Capability[]) {
    if (draft.uniform) {
      onChange({ ...draft, shared: next });
      return;
    }
    if (!active) return;
    onChange({ ...draft, perNode: { ...draft.perNode, [active]: next } });
  }

  /** Give every ticked node the set currently on screen. */
  function applyToAll() {
    if (!active) return;
    const caps = capsOf(active);
    const perNode = { ...draft.perNode };
    for (const key of keys) perNode[key] = caps;
    onChange({ ...draft, perNode });
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border",
        locked && "bg-muted/30",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar className="size-6 shrink-0">
            <AvatarFallback className="text-[10px]">
              {access.teamName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-medium">{access.teamName}</span>
          {access.isFounder && (
            <Badge variant="secondary" className="gap-1 px-1.5 py-0">
              <Crown className="size-3" />
              Founder
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div
            role="radiogroup"
            aria-label={`Access mode in ${access.teamName}`}
            className="flex gap-1"
          >
            {(
              [
                ["Role", false],
                ["Granular", true],
              ] as const
            ).map(([label, on]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={draft.granular === on}
                disabled={locked}
                onClick={() => onChange({ ...draft, granular: on })}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                  draft.granular === on
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <InfoTip content="Role gives them the same access everywhere in this team. Granular adds the projects, folders and apps where a different set applies." />
          {!access.isFounder && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={onRemove}
              aria-label={`Remove from ${access.teamName}`}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-4 border-t border-border p-3">
        {access.isFounder && (
          <p className="text-xs text-muted-foreground">
            They created this team, so their access here can&apos;t be changed by
            anyone.
          </p>
        )}

        <div className="space-y-2">
          <FieldLabel
            htmlFor={`role-${access.teamId}`}
            info={
              draft.granular
                ? "Where they start. Anything ticked below replaces it inside that node."
                : "What they can do everywhere in this team."
            }
          >
            {draft.granular ? "Base role" : "Role"}
          </FieldLabel>
          <Select
            value={draft.roleId}
            disabled={locked}
            onValueChange={(v) => onChange({ ...draft, roleId: v })}
          >
            <SelectTrigger id={`role-${access.teamId}`} className="w-full">
              <SelectValue placeholder="Pick a role" />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {draft.granular && tree && (
          <>
            <ScopePicker
              tree={[tree]}
              selection={draft.selection}
              onChange={(selection) => onChange({ ...draft, selection })}
              disabled={locked}
              title="Where"
              info="Tick a project, a folder or a single app. Everything inside a ticked node is included."
              footer={
                <p className="text-xs text-muted-foreground">
                  Inside these they can do what is ticked below, even things their
                  role doesn&apos;t allow. Everywhere else the role applies.
                </p>
              }
              renderMeta={(node) =>
                node.kind === "team" || !node.checked ? null : (
                  <button
                    type="button"
                    disabled={locked || draft.uniform}
                    onClick={() => setFocus(`${node.kind}:${node.id}` as NodeKey)}
                    className={cn(
                      "rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors",
                      !draft.uniform &&
                        !locked &&
                        "hover:bg-accent hover:text-foreground",
                      active === `${node.kind}:${node.id}` &&
                        !draft.uniform &&
                        "border-primary text-foreground",
                      draft.uniform && "cursor-default",
                    )}
                  >
                    {draft.uniform
                      ? "Same as the rest"
                      : `${capsOf(`${node.kind}:${node.id}` as NodeKey).length} permissions`}
                  </button>
                )
              }
            />

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <span className="truncate">Same permissions everywhere</span>
                <InfoTip content="One set for every node you tick. Turn it off to give each node its own." />
              </p>
              <Switch
                aria-label="Same permissions everywhere"
                checked={draft.uniform}
                disabled={locked}
                onCheckedChange={(uniform) => {
                  // Turning it on flattens to the focused set, so what you see is
                  // what every node gets — not a silent pick of one of them.
                  const caps = active ? capsOf(active) : draft.shared;
                  onChange({ ...draft, uniform, shared: caps });
                }}
              />
            </div>

            {keys.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Tick something above to say what they can do there.
              </p>
            ) : (
              <>
                {!draft.uniform && active && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Editing{" "}
                      <span className="font-medium text-foreground">
                        {names.get(active) ?? "this node"}
                      </span>
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={locked}
                      onClick={applyToAll}
                    >
                      Apply to every ticked node
                    </Button>
                  </div>
                )}
                <PermissionPicker
                  capabilities={active ? capsOf(active) : draft.shared}
                  onChange={setCaps}
                  disabled={locked}
                  only={NODE_GRANTABLE_CAPABILITIES}
                  hint="What they can do inside everything ticked above. Team-wide permissions aren't offered here."
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Every node in the team's tree, keyed like the selection — for the "Editing X" line. */
function namesInTree(tree: ScopeTreeTeam | undefined): Map<NodeKey, string> {
  const out = new Map<NodeKey, string>();
  if (!tree) return out;
  const walkFolder = (f: {
    id: string;
    name: string;
    folders: { id: string; name: string; folders: unknown[]; apps: unknown[] }[];
    apps: { id: string; name: string }[];
  }) => {
    out.set(`folder:${f.id}`, f.name);
    for (const a of f.apps) out.set(`app:${a.id}`, a.name);
    for (const c of f.folders) walkFolder(c as Parameters<typeof walkFolder>[0]);
  };
  for (const p of tree.projects) {
    out.set(`project:${p.id}`, p.name);
    for (const a of p.apps) out.set(`app:${a.id}`, a.name);
    for (const f of p.folders) walkFolder(f);
  }
  for (const f of tree.folders) walkFolder(f);
  for (const a of tree.looseApps) out.set(`app:${a.id}`, a.name);
  return out;
}

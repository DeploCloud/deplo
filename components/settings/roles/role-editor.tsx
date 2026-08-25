"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  Loader2,
  Lock,
  RotateCcw,
  Trash2,
  Fingerprint,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { PermissionPicker } from "@/components/settings/permission-picker";
import { gqlAction } from "@/lib/graphql-client";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import { CAPABILITY_CATEGORIES, CAPABILITY_META } from "@/lib/capabilities";
import { PROJECT_SCOPED_CAPABILITIES } from "@/lib/membership-shared";
import {
  ScopePicker,
  coversEverything,
  everythingSelection,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import { sameCapabilities } from "@/lib/membership-shared";
import type { TeamRoleDTO } from "@/lib/data/roles";

/**
 * The role editor: a page, not a dialog.
 */
export function RoleEditor({
  mode,
  role,
  basedOn,
  canManage,
  tree,
}: {
  mode: "create" | "edit";
  /** The role being edited. */
  role?: TeamRoleDTO;
  /** The role a new one was started from (chosen in the "New role" menu). */
  basedOn?: TeamRoleDTO | null;
  canManage: boolean;
  /** The team's projects, folders and apps — the tree the Scope card draws. */
  tree: ScopeTreeTeam[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);

  const initial = React.useMemo(
    () => ({
      name: role?.name ?? (basedOn ? `${basedOn.name} copy` : ""),
      description: role?.description ?? basedOn?.description ?? "",
      capabilities: role?.capabilities ??
        basedOn?.capabilities ?? ["view" as Capability],
      requireTwoFactor:
        role?.requireTwoFactor ?? basedOn?.requireTwoFactor ?? false,
      // Unrestricted shows as everything ticked, not as an empty tree: this is
      // the control an admin narrows, and starting it blank made "reaches the
      // whole team" look identical to "reaches nothing".
      scope:
        (role?.scope ?? basedOn?.scope ?? null) != null
          ? toSelection(role?.scope ?? basedOn?.scope ?? null)
          : everythingSelection(tree),
    }),
    [role, basedOn, tree],
  );

  const [name, setName] = React.useState(initial.name);
  const [description, setDescription] = React.useState(initial.description);
  const [caps, setCaps] = React.useState<Capability[]>(initial.capabilities);
  const [twoFactor, setTwoFactor] = React.useState(initial.requireTwoFactor);
  const [scope, setScope] = React.useState<ScopeSelection>(initial.scope);

  const locked = role?.locked ?? false;
  const readOnly = locked || !canManage;
  const granted = caps.filter((c) => c !== "view").length;
  const sensitive = caps.filter((c) => CAPABILITY_META[c].sensitive).length;
  const ticked =
    scope.projectIds.length +
    (scope.environmentIds?.length ?? 0) +
    scope.folderIds.length +
    scope.appIds.length;
  // Untick anything at all and the role is limited; put every top-level node back and
  // it is unrestricted again — which is stored as no scope at all, so the project
  // somebody creates tomorrow is included.
  const scoped = !coversEverything(tree, scope);
  // What the scope silences.
  const mutedCaps = React.useMemo(
    () =>
      scoped
        ? ALL_CAPABILITIES.filter(
            (c) => !PROJECT_SCOPED_CAPABILITIES.includes(c),
          )
        : [],
    [scoped],
  );
  const outOfScope = caps.filter((c) => mutedCaps.includes(c)).length;
  const dirty =
    name !== initial.name ||
    description !== initial.description ||
    twoFactor !== initial.requireTwoFactor ||
    !sameCapabilities(caps, initial.capabilities) ||
    !sameScope(scope, initial.scope);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || !name.trim()) return;
    startTransition(async () => {
      if (mode === "create") {
        const res = await gqlAction<
          { createRole: { id: string } },
          { id: string }
        >(
          `mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }`,
          {
            input: {
              name,
              description,
              capabilities: caps,
              requireTwoFactor: twoFactor,
              scope: scoped ? scopeInput(scope) : null,
            },
          },
          (d) => d.createRole,
        );
        if (res.ok && res.data) {
          toast.success(`Created the ${name.trim()} role`);
          router.push(`/settings/roles/${res.data.id}`);
          router.refresh();
        } else if (!res.ok) {
          toast.error(res.error);
        }
        return;
      }
      const res = await gqlAction(
        `mutation($input: UpdateRoleInput!) { updateRole(input: $input) }`,
        {
          input: {
            id: role!.id,
            name,
            description,
            capabilities: caps,
            requireTwoFactor: twoFactor,
            // Two fields, because "absent" has to keep meaning "leave it alone"
            // for every client that predates the scope.
            scope: scoped ? scopeInput(scope) : undefined,
            clearScope: !scoped,
          },
        },
      );
      if (res.ok) {
        toast.success(
          role!.memberCount > 0
            ? `Saved — ${role!.memberCount} member${role!.memberCount === 1 ? "" : "s"} updated`
            : "Role saved",
        );
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <form
      className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]"
      onSubmit={submit}
    >
      <div className="space-y-4">
        {locked && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
            <Lock className="mt-0.5 size-4 shrink-0" />
            <p>
              The Owner role always has every permission and can&apos;t be
              edited. A team that could edit its way out of administering itself
              would have no way back.
            </p>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="role-name"
                info="Shown wherever the role is assigned — on the Members page and in the add-member dialog."
              >
                Name
              </FieldLabel>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Developer"
                maxLength={40}
                disabled={readOnly}
                autoFocus={mode === "create"}
              />
            </div>
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="role-description"
                info="One line telling the next admin who this role is for. Optional."
              >
                Description
              </FieldLabel>
              <Input
                id="role-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ships apps, doesn't touch infrastructure"
                maxLength={160}
                disabled={readOnly}
              />
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Fingerprint className="size-4 text-muted-foreground" />
                  Require two-factor authentication
                </p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  Members with this role must have 2FA enrolled. Until they do,
                  they resolve no permissions at all — in the dashboard and over
                  the API alike.
                </p>
              </div>
              <Switch
                checked={twoFactor}
                disabled={readOnly}
                onCheckedChange={setTwoFactor}
                aria-label="Require two-factor authentication"
              />
            </div>
          </CardContent>
        </Card>

        {/* Scope before Permissions, as the token editor orders them: the reach
            decides what the permissions MEAN, so it is read first. */}
        <Card>
          <CardContent className="pt-6">
            <ScopePicker
              tree={tree}
              selection={scope}
              onChange={setScope}
              disabled={readOnly}
              teamPickable={false}
              info="Where this role can work. Everything is ticked to begin with - untick what its holders should not reach."
              emptyNote="This team has nothing to limit a role to yet."
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <PermissionPicker
              capabilities={caps}
              onChange={setCaps}
              disabled={readOnly}
              muted={
                mutedCaps.length > 0
                  ? {
                      caps: mutedCaps,
                      reason:
                        "This role only reaches part of the team, so this one has nothing to apply to.",
                    }
                  : undefined
              }
            />
          </CardContent>
        </Card>
      </div>

      {/* Right rail: what this role will grant, and the primary action —
          sticky on desktop so it stays reachable while scrolling the list. */}
      <aside className="h-fit space-y-4 xl:sticky xl:top-20">
        <Card>
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Summary
              <InfoTip content="Exactly what a member holding this role will be able to do." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Name</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {name.trim() || "—"}
                </dd>
              </div>
              {mode === "create" && (
                <div className="flex items-center gap-3">
                  <dt className="shrink-0 text-muted-foreground">Based on</dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium">
                    {basedOn ? basedOn.name : "Nothing (blank)"}
                  </dd>
                </div>
              )}
              {mode === "edit" && (
                <div className="flex items-center gap-3">
                  <dt className="shrink-0 text-muted-foreground">Members</dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium tabular-nums">
                    {role!.memberCount}
                  </dd>
                </div>
              )}
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Access</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {!scoped
                    ? "Whole team"
                    : ticked === 0
                      ? "Nothing"
                      : describeScope(scope)}
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Permissions</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium tabular-nums">
                  {granted} of {ALL_CAPABILITIES.length - 1}
                </dd>
              </div>
              {outOfScope > 0 && (
                <div className="flex items-center gap-3">
                  <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    Out of reach
                    <InfoTip content="These are ticked but do nothing while the role is limited. Widen its access or untick them." />
                  </dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium tabular-nums">
                    {outOfScope}
                  </dd>
                </div>
              )}
              {sensitive > 0 && (
                <div className="flex items-center gap-3">
                  <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    <ShieldAlert className="size-3.5 text-amber-500" />
                    Sensitive
                  </dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium tabular-nums">
                    {sensitive}
                  </dd>
                </div>
              )}
            </dl>

            <div className="space-y-1.5">
              {CAPABILITY_CATEGORIES.map((cat) => {
                const n = cat.caps.filter((c) => caps.includes(c)).length;
                return (
                  <div
                    key={cat.key}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span
                      className={
                        n === 0
                          ? "text-muted-foreground/60"
                          : "text-muted-foreground"
                      }
                    >
                      {cat.label}
                    </span>
                    <Badge
                      variant={n === 0 ? "muted" : "secondary"}
                      className="tabular-nums"
                    >
                      {n}/{cat.caps.length}
                    </Badge>
                  </div>
                );
              })}
            </div>

            {twoFactor && (
              <Badge
                variant="outline"
                className="w-full justify-center gap-1.5"
              >
                <Fingerprint className="size-3" />
                Two-factor required
              </Badge>
            )}

            {!readOnly && (
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={
                  pending || !name.trim() || (mode === "edit" && !dirty)
                }
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                {mode === "create"
                  ? "Create role"
                  : dirty
                    ? "Save changes"
                    : "Saved"}
              </Button>
            )}

            {mode === "edit" &&
              canManage &&
              role!.builtinKey &&
              role!.modified &&
              !locked && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => setResetOpen(true)}
                >
                  <RotateCcw className="size-4" />
                  Reset to default
                </Button>
              )}
            {mode === "edit" && canManage && !role!.builtinKey && (
              <Button
                type="button"
                variant="outline"
                className="w-full text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-4" />
                Delete role
              </Button>
            )}
          </CardContent>
        </Card>
      </aside>

      {mode === "edit" && (
        <>
          <ConfirmAction
            open={resetOpen}
            onOpenChange={setResetOpen}
            title={`Reset ${role!.name} to its default?`}
            description={
              role!.memberCount > 0
                ? `Its name and permissions go back to what deplo ships, for the ${role!.memberCount} member${role!.memberCount === 1 ? "" : "s"} who hold it too.`
                : "Its name and permissions go back to what deplo ships."
            }
            confirmLabel="Reset"
            variant="default"
            successMessage="Role reset to its default"
            onConfirm={async () => {
              const res = await gqlAction(
                `mutation($id: String!) { resetRole(id: $id) }`,
                { id: role!.id },
              );
              if (res.ok) router.refresh();
              return res;
            }}
          />
          <ConfirmAction
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Delete role?"
            description={
              role!.memberCount > 0
                ? `${role!.memberCount} member${role!.memberCount === 1 ? "" : "s"} still hold ${role!.name}. Move them to another role first.`
                : `Nobody holds ${role!.name}, so nothing changes for your members.`
            }
            confirmLabel="Delete"
            confirmDisabled={role!.memberCount > 0}
            successMessage="Role deleted"
            onConfirm={async () => {
              const res = await gqlAction(
                `mutation($id: String!) { deleteRole(id: $id) }`,
                { id: role!.id },
              );
              if (res.ok) {
                router.push("/settings/roles");
                router.refresh();
              }
              return res;
            }}
          />
        </>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** The DTO's scope as the picker's selection. Null (unrestricted) is empty. */
function toSelection(
  scope: {
    projectIds: string[];
    environmentIds: string[];
    folderIds: string[];
    appIds: string[];
  } | null,
): ScopeSelection {
  return {
    teamIds: [],
    projectIds: scope?.projectIds ?? [],
    environmentIds: scope?.environmentIds ?? [],
    folderIds: scope?.folderIds ?? [],
    appIds: scope?.appIds ?? [],
  };
}

/**
 * The four fields `RoleScopeInput` defines, and only those.
 */
function scopeInput(scope: ScopeSelection) {
  return {
    projectIds: scope.projectIds,
    environmentIds: scope.environmentIds ?? [],
    folderIds: scope.folderIds,
    appIds: scope.appIds,
  };
}

/** Order-blind: the picker emits its sets in whatever order it walked them. */
function sameScope(a: ScopeSelection, b: ScopeSelection): boolean {
  const same = (x: string[], y: string[]) =>
    x.length === y.length && [...x].sort().join() === [...y].sort().join();
  return (
    same(a.projectIds, b.projectIds) &&
    same(a.environmentIds ?? [], b.environmentIds ?? []) &&
    same(a.folderIds, b.folderIds) &&
    same(a.appIds, b.appIds)
  );
}

/** "2 projects and 1 app" — the one-line shape of a scope. */
function describeScope(scope: ScopeSelection): string {
  const plural = (n: number, one: string) =>
    `${n} ${n === 1 ? one : `${one}s`}`;
  const envs = scope.environmentIds ?? [];
  const parts = [
    scope.projectIds.length > 0
      ? plural(scope.projectIds.length, "project")
      : null,
    envs.length > 0 ? plural(envs.length, "environment") : null,
    scope.folderIds.length > 0
      ? plural(scope.folderIds.length, "folder")
      : null,
    scope.appIds.length > 0 ? plural(scope.appIds.length, "app") : null,
  ].filter((p): p is string => p != null);
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

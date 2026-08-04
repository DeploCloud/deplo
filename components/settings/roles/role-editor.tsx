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
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { sameCapabilities } from "@/lib/membership-shared";
import type { TeamRoleDTO } from "@/lib/data/roles";

/**
 * The role editor: a page, not a dialog. Forty permissions, a search box and a
 * summary of what the role ends up granting do not fit in a modal — and this is
 * the same shape as creating an app (config on the left, a sticky summary and the
 * primary action on the right), so the flow is one people have already done.
 */
export function RoleEditor({
  mode,
  role,
  basedOn,
  canManage,
}: {
  mode: "create" | "edit";
  /** The role being edited. */
  role?: TeamRoleDTO;
  /** The role a new one was started from (chosen in the "New role" menu). */
  basedOn?: TeamRoleDTO | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);

  const initial = React.useMemo(
    () => ({
      name: role?.name ?? (basedOn ? `${basedOn.name} copy` : ""),
      description: role?.description ?? basedOn?.description ?? "",
      capabilities: role?.capabilities ?? basedOn?.capabilities ?? ["view" as Capability],
      requireTwoFactor: role?.requireTwoFactor ?? basedOn?.requireTwoFactor ?? false,
    }),
    [role, basedOn],
  );

  const [name, setName] = React.useState(initial.name);
  const [description, setDescription] = React.useState(initial.description);
  const [caps, setCaps] = React.useState<Capability[]>(initial.capabilities);
  const [twoFactor, setTwoFactor] = React.useState(initial.requireTwoFactor);

  const locked = role?.locked ?? false;
  const readOnly = locked || !canManage;
  const granted = caps.filter((c) => c !== "view").length;
  const sensitive = caps.filter((c) => CAPABILITY_META[c].sensitive).length;
  const dirty =
    name !== initial.name ||
    description !== initial.description ||
    twoFactor !== initial.requireTwoFactor ||
    !sameCapabilities(caps, initial.capabilities);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || !name.trim()) return;
    startTransition(async () => {
      if (mode === "create") {
        const res = await gqlAction<{ createRole: { id: string } }, { id: string }>(
          `mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }`,
          {
            input: {
              name,
              description,
              capabilities: caps,
              requireTwoFactor: twoFactor,
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
    <form className="grid items-start gap-6 xl:grid-cols-[1fr_320px]" onSubmit={submit}>
      <div className="space-y-4">
        {locked && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
            <Lock className="mt-0.5 size-4 shrink-0" />
            <p>
              The Owner role always has every permission and can&apos;t be edited.
              A team that could edit its way out of administering itself would have
              no way back.
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

        <Card>
          <CardContent className="pt-6">
            <PermissionPicker
              capabilities={caps}
              onChange={setCaps}
              disabled={readOnly}
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
                <dt className="shrink-0 text-muted-foreground">Permissions</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium tabular-nums">
                  {granted} of {ALL_CAPABILITIES.length - 1}
                </dd>
              </div>
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
                        n === 0 ? "text-muted-foreground/60" : "text-muted-foreground"
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
              <Badge variant="outline" className="w-full justify-center gap-1.5">
                <Fingerprint className="size-3" />
                Two-factor required
              </Badge>
            )}

            {!readOnly && (
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={pending || !name.trim() || (mode === "edit" && !dirty)}
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

            {mode === "edit" && canManage && role!.builtinKey && role!.modified && !locked && (
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
            title={`Delete the ${role!.name} role?`}
            description={
              role!.memberCount > 0
                ? `${role!.memberCount} member${role!.memberCount === 1 ? "" : "s"} still hold this role. Move them to another role first.`
                : "Nobody holds this role, so nothing changes for your members."
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

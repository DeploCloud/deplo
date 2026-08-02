"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Crown,
  UserCog,
  Eye,
  Shield,
  Pencil,
  Trash2,
  RotateCcw,
  Lock,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RolePermissionPicker } from "@/components/settings/roles/role-permission-picker";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { capabilitiesForRole } from "@/lib/membership-shared";
import type { Capability } from "@/lib/types";
import type { TeamRoleDTO } from "@/lib/data/roles";

/** The face of a role in the list: default roles keep their familiar mark. */
const ROLE_ICON: Record<string, LucideIcon> = {
  owner: Crown,
  member: UserCog,
  viewer: Eye,
};

export function RolesManager({
  roles,
  canManage,
}: {
  roles: TeamRoleDTO[];
  /** `manage_members` — without it the page is a read-only reference. */
  canManage: boolean;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TeamRoleDTO | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Roles
          <InfoTip content="A role is what a member can do in this team. Assign one to each member on the Members page — editing a role updates everyone who holds it." />
        </CardTitle>
        {canManage && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New role
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {roles.map((role) => (
          <RoleRow
            key={role.id}
            role={role}
            canManage={canManage}
            onEdit={() => setEditing(role)}
          />
        ))}
      </CardContent>

      {createOpen && (
        <RoleDialog
          mode="create"
          roles={roles}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}
      {editing && (
        <RoleDialog
          mode="edit"
          role={editing}
          roles={roles}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </Card>
  );
}

function RoleRow({
  role,
  canManage,
  onEdit,
}: {
  role: TeamRoleDTO;
  canManage: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [resetOpen, setResetOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const Icon = role.builtinKey ? ROLE_ICON[role.builtinKey] : Shield;
  const optional = role.capabilities.filter((c) => c !== "view").length;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          role.builtinKey === "owner"
            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            : "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          {role.name}
          {role.builtinKey ? (
            <Badge variant="muted">Default</Badge>
          ) : (
            <Badge variant="outline">Custom</Badge>
          )}
          {role.modified && !role.locked && (
            <SimpleTooltip content="Edited away from the default it ships with">
              <span>
                <Badge variant="outline">Edited</Badge>
              </span>
            </SimpleTooltip>
          )}
          {role.locked && (
            <SimpleTooltip content="The Owner role always has full access, so a team can never edit its way out of administering itself.">
              <span>
                <Badge variant="muted" className="gap-1">
                  <Lock className="size-3" />
                  Locked
                </Badge>
              </span>
            </SimpleTooltip>
          )}
        </p>
        {role.description && (
          <p className="truncate text-xs text-muted-foreground">
            {role.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {/* A role with nothing but the `view` floor reads as "View only" — "0
            permissions" would suggest it grants no access at all. */}
        <Badge variant="secondary" className="tabular-nums">
          {optional === 0
            ? "View only"
            : `${optional} permission${optional === 1 ? "" : "s"}`}
        </Badge>
        <Badge variant="muted" className="tabular-nums">
          {role.memberCount} member{role.memberCount === 1 ? "" : "s"}
        </Badge>
      </div>
      {canManage && (
        <div className="flex items-center gap-1">
          <SimpleTooltip
            content={
              role.locked
                ? "The Owner role can't be edited"
                : "Edit this role's name and permissions"
            }
          >
            <span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onEdit}
                disabled={role.locked}
                aria-label={`Edit ${role.name}`}
              >
                <Pencil className="size-4" />
              </Button>
            </span>
          </SimpleTooltip>
          {role.builtinKey && role.modified && !role.locked && (
            <SimpleTooltip content="Restore this role to its default name and permissions">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setResetOpen(true)}
                aria-label={`Reset ${role.name}`}
              >
                <RotateCcw className="size-4" />
              </Button>
            </SimpleTooltip>
          )}
          {!role.builtinKey && (
            <SimpleTooltip content="Delete this role">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDeleteOpen(true)}
                aria-label={`Delete ${role.name}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </SimpleTooltip>
          )}
        </div>
      )}

      <ConfirmAction
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={`Reset ${role.name} to its default?`}
        description={
          role.memberCount > 0
            ? `Its name and permissions go back to what Deplo ships, for the ${role.memberCount} member${role.memberCount === 1 ? "" : "s"} who hold it too.`
            : "Its name and permissions go back to what Deplo ships."
        }
        confirmLabel="Reset"
        variant="default"
        successMessage="Role reset to its default"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { resetRole(id: $id) }`,
            { id: role.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
      <ConfirmAction
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete the ${role.name} role?`}
        description={
          role.memberCount > 0
            ? `${role.memberCount} member${role.memberCount === 1 ? "" : "s"} still hold this role. Move them to another role first.`
            : "Nobody holds this role, so nothing changes for your members."
        }
        confirmLabel="Delete"
        confirmDisabled={role.memberCount > 0}
        successMessage="Role deleted"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { deleteRole(id: $id) }`,
            { id: role.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit                                                       */
/* ------------------------------------------------------------------ */

function RoleDialog({
  mode,
  role,
  roles,
  open,
  onOpenChange,
}: {
  mode: "create" | "edit";
  role?: TeamRoleDTO;
  /** Every role of the team — the "start from" presets when creating. */
  roles: TeamRoleDTO[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState(role?.name ?? "");
  const [description, setDescription] = React.useState(role?.description ?? "");
  const [caps, setCaps] = React.useState<Capability[]>(
    role?.capabilities ?? capabilitiesForRole("viewer"),
  );
  const [preset, setPreset] = React.useState<string>("");

  function applyPreset(id: string) {
    setPreset(id);
    const source = roles.find((r) => r.id === id);
    if (source) setCaps(source.capabilities);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res =
        mode === "create"
          ? await gqlAction(
              `mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }`,
              { input: { name, description, capabilities: caps } },
            )
          : await gqlAction(
              `mutation($input: UpdateRoleInput!) { updateRole(input: $input) }`,
              { input: { id: role!.id, name, description, capabilities: caps } },
            );
      if (res.ok) {
        toast.success(mode === "create" ? "Role created" : "Role updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const members = role?.memberCount ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New role" : `Edit ${role?.name}`}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Name it after the job it does, then pick what it can reach."
              : members > 0
                ? `Saving applies these permissions to the ${members} member${members === 1 ? "" : "s"} who hold this role.`
                : "Nobody holds this role yet, so saving changes nothing for your members."}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit}>
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
              autoFocus
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
              placeholder="Deploys apps, doesn't touch infrastructure"
              maxLength={160}
            />
          </div>

          {mode === "create" && roles.length > 0 && (
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="role-preset"
                info="Copies an existing role's permissions as a starting point. You can change them below."
              >
                Start from
              </FieldLabel>
              <Select value={preset} onValueChange={applyPreset}>
                <SelectTrigger id="role-preset">
                  <SelectValue placeholder="An existing role (optional)" />
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
          )}

          <RolePermissionPicker
            capabilities={caps}
            onChange={setCaps}
            idPrefix={mode === "create" ? "new-role" : `role-${role?.id}`}
          />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {mode === "create" ? "Create role" : "Save role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

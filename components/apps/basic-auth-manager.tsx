"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Lock } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

export interface BasicAuthUserDTO {
  id: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * App Settings → HTTP Basic Auth. Create username/password credentials that
 * gate EVERY domain of the app: when one or more exist, the deploy/reroute
 * pipeline puts a generated Traefik `basicauth` middleware in front of all the
 * app's hostnames. Passwords are write-only (never shown after saving).
 *
 * Like every other domain change in Deplo, edits apply on the NEXT deploy — or
 * instantly via the app's "Reload" action (which re-renders the routing
 * labels without a rebuild).
 */
export function BasicAuthManager({
  appId,
  users,
}: {
  appId: string;
  users: BasicAuthUserDTO[];
}) {
  const [editing, setEditing] = React.useState<BasicAuthUserDTO | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              HTTP Basic Auth
              <InfoTip content="Protect every domain of this app behind a username and password. Changes apply on the next deploy, or instantly via Reload." />
            </CardTitle>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" />
            Add user
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <EmptyState
            icon={Lock}
            title="No basic-auth users"
            description="Add a user to require a login on all of this app's domains."
          />
        ) : (
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Password</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs font-medium">
                      {u.username}
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs text-muted-foreground">
                        ••••••••••••
                      </code>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            setEditing(u);
                            setDialogOpen(true);
                          }}
                          aria-label="Change password"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteId(u.id)}
                          aria-label="Delete"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <BasicAuthDialog
        key={editing?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appId={appId}
        editing={editing}
      />
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete basic-auth user?"
        description="This removes the credential. The login it grants stops working after the next deploy or Reload."
        confirmLabel="Delete"
        successMessage="User deleted"
        onConfirm={async () => {
          const res = await gqlAction<{ removeBasicAuthUser: boolean }>(
            `mutation($id: String!) { removeBasicAuthUser(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </Card>
  );
}

function BasicAuthDialog({
  open,
  onOpenChange,
  appId,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  editing: BasicAuthUserDTO | null;
}) {
  const [username, setUsername] = React.useState(editing?.username ?? "");
  const [password, setPassword] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  function submit() {
    startTransition(async () => {
      const res = editing
        ? await gqlAction<{ updateBasicAuthUserPassword: { id: string } }>(
            `mutation($id: String!, $password: String!) {
              updateBasicAuthUserPassword(id: $id, password: $password) { id }
            }`,
            { id: editing.id, password },
          )
        : await gqlAction<{ addBasicAuthUser: { id: string } }>(
            `mutation($appId: String!, $username: String!, $password: String!) {
              addBasicAuthUser(appId: $appId, username: $username, password: $password) { id }
            }`,
            { appId, username, password },
          );
      if (res.ok) {
        toast.success(editing ? "Password updated" : "User added");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? `Change password — ${editing.username}` : "Add basic-auth user"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Set a new password for this user. The username can't be changed."
              : "This credential will be required on every domain of the app."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Username</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alice"
              className="font-mono text-sm"
              disabled={!!editing}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={editing ? "Enter a new password" : "Password"}
              autoComplete="new-password"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !password.trim() || (!editing && !username.trim())}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

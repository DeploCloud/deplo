"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { RegistryMark } from "@/components/shared/brand-icons";
import { RegistryGraphic } from "@/components/settings/registry-graphic";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import type { RegistryDTO } from "@/lib/data/registries";
import type { RegistryType } from "@/lib/types";

const TYPE_META: Record<
  RegistryType,
  { label: string; host: string; userPlaceholder: string }
> = {
  ghcr: { label: "GitHub (ghcr.io)", host: "ghcr.io", userPlaceholder: "github-username" },
  dockerhub: { label: "Docker Hub", host: "docker.io", userPlaceholder: "docker-username" },
  gitlab: { label: "GitLab", host: "registry.gitlab.com", userPlaceholder: "gitlab-username" },
  generic: { label: "Generic / self-hosted", host: "", userPlaceholder: "username" },
};

/**
 * The whole Registries page: one header, one grid of connected registries, one
 * empty state - the shape the Git settings page uses, for the same reason. A
 * registry is a host this team connected to, exactly like a git host, and two
 * pages that answer the same question have no business looking different.
 *
 * The page body is one client component because the header's Add button and the
 * dialog it opens are the same interaction.
 */
export function RegistriesPanel({ registries }: { registries: RegistryDTO[] }) {
  const router = useRouter();
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<RegistryDTO | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Registries
            <Badge variant="info" className="font-normal">
              Beta
            </Badge>
          </span>
        }
        description="Container image registries used to pull and push images."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            Add registry
          </Button>
        }
      />

      {registries.length === 0 ? (
        <EmptyState
          graphic={<RegistryGraphic />}
          title="No registry connected"
          description="Connect one and its private images are yours to deploy, with the credentials kept here."
        />
      ) : (
        <div className="grid items-start gap-4 sm:grid-cols-2 3xl:grid-cols-3">
          {registries.map((r) => (
            <RegistryCard
              key={r.id}
              registry={r}
              onRemove={() => setDeleting(r)}
            />
          ))}
        </div>
      )}

      {/* Mounted only while open, so its fields seed from their initial state
          instead of an effect that resets them. */}
      {addOpen && <AddRegistryDialog onDone={() => setAddOpen(false)} />}

      <ConfirmAction
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Remove registry?"
        description="Deployments using private images from this registry will no longer authenticate."
        confirmLabel="Remove"
        successMessage="Registry removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { deleteRegistry(id: $id) }`,
            { id: deleting!.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

/**
 * One connected registry. Same card as a git host card: the mark says which
 * provider it is, the title is what the team called it, the subtitle is where it
 * actually authenticates, and everything you can do to it lives in the kebab.
 */
function RegistryCard({
  registry,
  onRemove,
}: {
  registry: RegistryDTO;
  onRemove: () => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <RegistryMark type={registry.type} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{registry.name}</p>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {registry.username}@{registry.registryUrl}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Actions for ${registry.name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 className="size-4" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}

function AddRegistryDialog({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<RegistryType>("ghcr");
  const [registryUrl, setRegistryUrl] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const meta = TYPE_META[type];

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: AddRegistryInput!) { addRegistry(input: $input) }`,
        {
          input: {
            name,
            type,
            registryUrl: registryUrl.trim() || undefined,
            username,
            password,
          },
        },
      );
      if (res.ok) {
        toast.success("Registry added");
        router.refresh();
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent>
      <DialogHeader>
        <DialogTitle>Add registry</DialogTitle>
        <DialogDescription>
          Use an access token where possible instead of a password.
        </DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My registry"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <FieldLabel info="The registry provider. Selecting one sets the default host and a matching username placeholder.">
                Type
              </FieldLabel>
              <Select value={type} onValueChange={(v) => setType(v as RegistryType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_META) as RegistryType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_META[t].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <FieldLabel
                info={
                  <>
                    Hostname of the registry to authenticate against, such as{" "}
                    <code className="font-mono">ghcr.io</code>. Leave blank to use
                    the selected provider&apos;s default host.
                  </>
                }
              >
                Registry host
              </FieldLabel>
              <Input
                value={registryUrl}
                onChange={(e) => setRegistryUrl(e.target.value)}
                placeholder={meta.host || "registry.example.com"}
                className="font-mono text-sm"
              />
            </div>
          </div>
          <div className="space-y-2">
            <FieldLabel info="The account name used to sign in to the selected registry.">
              Username
            </FieldLabel>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={meta.userPlaceholder}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Password or access token</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={pending || !name.trim() || !username.trim() || !password}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            Add registry
          </Button>
        </DialogFooter>
      </form>
      </DialogContent>
    </Dialog>
  );
}

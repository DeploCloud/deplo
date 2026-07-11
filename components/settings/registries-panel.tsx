"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Boxes } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
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

export function RegistriesPanel({ registries }: { registries: RegistryDTO[] }) {
  const router = useRouter();
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <Boxes className="size-4" />
            Container registries
            <InfoTip content="Connect registries to pull private images and push built images. Credentials are encrypted at rest." />
          </CardTitle>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-4" />
              Add registry
            </Button>
          </DialogTrigger>
          <AddRegistryDialog onDone={() => setAddOpen(false)} />
        </Dialog>
      </CardHeader>
      <CardContent>
        {registries.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No registries connected"
            description="Add a registry to use private images in your deployments."
          />
        ) : (
          <div className="space-y-2">
            {registries.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {r.name}
                    <Badge variant="secondary" className="capitalize">
                      {r.type}
                    </Badge>
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {r.username}@{r.registryUrl}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteId(r.id)}
                  aria-label="Remove registry"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Remove registry?"
        description="Deployments using private images from this registry will no longer authenticate."
        confirmLabel="Remove"
        successMessage="Registry removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { deleteRegistry(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
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
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add registry</DialogTitle>
        <DialogDescription>
          Use an access token where possible instead of a password.
        </DialogDescription>
      </DialogHeader>
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
        <Button
          onClick={submit}
          disabled={pending || !name.trim() || !username.trim() || !password}
        >
          {pending ? "Adding…" : "Add registry"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2, Network, Plus, ServerCog } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { DocsLink } from "@/components/ui/docs-link";
import {
  AccessOption,
  ServerTeamAccess,
  accessIsComplete,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";
import { ServerRoleOptions } from "./server-role-options";

export function AddServer({
  autoOpen = false,
  teams = [],
}: {
  autoOpen?: boolean;
  teams?: TeamOption[];
} = {}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen);
  const [pending, startTransition] = React.useTransition();
  const [kind, setKind] = React.useState<"server" | "cluster">("server");
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [access, setAccess] = React.useState<ServerAccess>({
    allTeams: true,
    teamIds: [],
  });
  const [command, setCommand] = React.useState<string | null>(null);
  const [role, setRole] = React.useState<"everything" | "build" | "storage">(
    "everything",
  );

  React.useEffect(() => {
    if (autoOpen) router.replace("/settings/servers", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setKind("server");
    setName("");
    setHost("");
    setAccess({ allTeams: true, teamIds: [] });
    setRole("everything");
    setCommand(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (command) return;
    submit();
  }

  function submitCluster() {
    startTransition(async () => {
      const res = await gqlAction<{ createCluster: { id: string } }>(
        /* GraphQL */ `
          mutation CreateCluster(
            $name: String!
            $sharing: ClusterSharingInput!
          ) {
            createCluster(name: $name, sharing: $sharing) {
              id
            }
          }
        `,
        {
          name,
          sharing: {
            allTeams: access.allTeams,
            teamIds: access.allTeams ? [] : access.teamIds,
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Cluster ${name.trim()} created`);
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  function submit() {
    if (kind === "cluster") return submitCluster();
    startTransition(async () => {
      const res = await gqlAction<{
        addServer: { server: { id: string }; installCommand: string };
      }>(
        `mutation AddServer($input: AddServerInput!) {
          addServer(input: $input) {
            server { id }
            installCommand
          }
        }`,
        {
          input: {
            name,
            host,
            allTeams: access.allTeams,
            teamIds: access.allTeams ? [] : access.teamIds,
            storageOnly: role === "storage",
            buildOnly: role === "build",
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      toast.success(
        `${name || host} registered - run the install command on it`,
      );
      setCommand(res.data.addServer.installCommand);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerCog className="size-4" />
            {kind === "cluster" ? "Add a cluster" : "Add a server"}
          </DialogTitle>
          <DialogDescription>
            {command ? (
              "Run this once on the server. The agent installs itself and calls home."
            ) : kind === "cluster" ? (
              <>
                Several servers that act as one. If one stops, its Apps move to
                another. Nothing of Kubernetes is involved.{" "}
                <DocsLink topic="clusters.overview" />
              </>
            ) : (
              "Add a remote server: name it, then run the install command on it. Deplo never SSHes in."
            )}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-8" onSubmit={onSubmit}>
          <AnimatedHeight className="grid gap-4" scroll={false}>
            {command ? (
              <div className="space-y-2">
                <Label>Install command (shown once)</Label>
                <CommandLine command={command} />
                <p className="text-xs text-muted-foreground">
                  The command embeds a single-use token that expires in about an
                  hour. It is shown only now; if you lose it, re-mint one from
                  the server&rsquo;s menu.
                </p>
                {command.includes("http://") ? (
                  <p className="text-xs text-warning">
                    This panel is on an http address, so the installer is
                    downloaded over an unencrypted connection. Give Deplo a
                    domain with HTTPS before adding servers over an untrusted
                    network.
                  </p>
                ) : null}
              </div>
            ) : kind === "cluster" ? (
              <div className="space-y-4">
                <KindPicker kind={kind} onChange={setKind} disabled={pending} />
                <div className="space-y-2">
                  <Label htmlFor="clu-name">Name</Label>
                  <Input
                    id="clu-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="eu"
                  />
                </div>
                <ServerTeamAccess
                  value={access}
                  teams={teams}
                  onChange={setAccess}
                  disabled={pending}
                  info="Which teams are allowed to place Apps and databases on this cluster."
                  docs="clusters.teams"
                />
              </div>
            ) : (
              <div className="space-y-4">
                <KindPicker kind={kind} onChange={setKind} disabled={pending} />
                <div className="space-y-2">
                  <Label htmlFor="srv-name">Display name</Label>
                  <Input
                    id="srv-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="eu-west-1"
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="srv-host"
                    info="The machine's IP or DNS name. Apps deployed to this server are reached at it."
                    docs="servers.address"
                  >
                    Host or IP
                  </FieldLabel>
                  <Input
                    id="srv-host"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="203.0.113.24"
                    className="font-mono text-sm"
                  />
                </div>
                <ServerTeamAccess
                  value={access}
                  teams={teams}
                  onChange={setAccess}
                  disabled={pending}
                />
                <div className="space-y-2">
                  <FieldLabel
                    info="Changes what the install command sets up on the host. Most servers should do everything."
                    docs="servers.role"
                  >
                    What this server is for
                  </FieldLabel>
                  <ServerRoleOptions
                    value={role}
                    onChange={setRole}
                    disabled={() => pending}
                  />
                </div>
              </div>
            )}
          </AnimatedHeight>
          {command ? (
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  pending ||
                  !accessIsComplete(access) ||
                  (kind === "cluster" ? !name.trim() : !host.trim())
                }
              >
                <span className="grid place-items-center">
                  <span
                    className={cn(
                      "col-start-1 row-start-1",
                      pending && "invisible",
                    )}
                  >
                    {kind === "cluster" ? "Add cluster" : "Add server"}
                  </span>
                  {pending && (
                    <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                  )}
                </span>
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KindPicker({
  kind,
  onChange,
  disabled,
}: {
  kind: "server" | "cluster";
  onChange: (k: "server" | "cluster") => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" className="grid grid-cols-2 gap-2">
      <AccessOption
        icon={ServerCog}
        title="Server"
        description="One machine"
        selected={kind === "server"}
        disabled={disabled}
        onSelect={() => onChange("server")}
      />
      <AccessOption
        icon={Network}
        title="Cluster"
        description="Several servers as one"
        selected={kind === "cluster"}
        disabled={disabled}
        onSelect={() => onChange("cluster")}
      />
    </div>
  );
}

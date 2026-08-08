"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, ServerCog } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { Checkbox } from "@/components/ui/checkbox";
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";
import {
  ServerTeamAccess,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";

/**
 * Register a remote server (PLAN Part B, P1). No SSH-in: the operator names the
 * host, submits, and gets back a ONE-TIME install command to paste on the box.
 * The agent then calls home and provisions itself. The command embeds a
 * single-use token and is shown only once, so this is a two-step dialog:
 * register → reveal command (the dialog stays open on the command screen).
 */
export function AddServer({
  autoOpen = false,
  teams = [],
}: {
  autoOpen?: boolean;
  /** Every team in the instance, for the access picker (empty if not allowed). */
  teams?: TeamOption[];
} = {}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen);
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [access, setAccess] = React.useState<ServerAccess>({
    allTeams: true,
    teamIds: [],
  });
  const [command, setCommand] = React.useState<string | null>(null);
  // A box bought purely to hold backups. The install command then skips Docker
  // and Traefik entirely, and the server never appears as a deploy target.
  const [storageOnly, setStorageOnly] = React.useState(false);

  // Opened via the global "New ▸ Add server" menu (?new=1) → drop the param so a
  // refresh/Back doesn't reopen it.
  React.useEffect(() => {
    if (autoOpen) router.replace("/settings/servers", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setName("");
    setHost("");
    setAccess({ allTeams: true, teamIds: [] });
    setStorageOnly(false);
    setCommand(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Step two only reveals the install command (its footer button just closes),
    // so Enter must not register the server a second time.
    if (command) return;
    submit();
  }

  function submit() {
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
            storageOnly,
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      toast.success(`${name || host} registered — run the install command on it`);
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
            Connect a remote server
          </DialogTitle>
          <DialogDescription>
            {command
              ? storageOnly
                ? "Run this once on the server. It installs the Deplo agent only — no Docker, no proxy — and the agent then calls home to finish provisioning."
                : "Run this once on the server. It installs Docker (if needed) and the Deplo agent, which then calls home to finish provisioning."
              : "Register the host, then run the install command it gives you on the box. Deplo never SSHes in — the agent connects out to this control plane."}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={onSubmit}>
          {command ? (
            <div className="space-y-2">
              <Label>Install command (shown once)</Label>
              <CommandLine command={command} />
              <p className="text-muted-foreground text-xs">
                The command embeds a single-use token that expires in about an
                hour. It is shown only now; if you lose it, re-mint one from the
                server&rsquo;s menu.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
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
                  info="The address this control plane will reach the agent at, and where deployed apps for this server will be routed."
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
              {/* Advanced, and deliberately a checkbox rather than a mode: the
                  difference is what the installer does on the box, and it cannot
                  be changed afterwards without re-running it. */}
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
                <Checkbox
                  checked={storageOnly}
                  onCheckedChange={(v) => setStorageOnly(v === true)}
                  disabled={pending}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium">
                    Only store backups on this server
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Skips Docker and the proxy. Nothing is deployed here, and it
                    stays out of the deploy target list.
                  </span>
                </span>
              </label>
            </div>
          )}

          <DialogFooter>
            {command ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || !host.trim()}>
                  {pending ? "Registering…" : "Register server"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

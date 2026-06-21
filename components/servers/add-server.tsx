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
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Register a remote server (PLAN Part B, P1). No SSH-in: the operator names the
 * host, submits, and gets back a ONE-TIME install command to paste on the box.
 * The agent then calls home and provisions itself. The command embeds a
 * single-use token and is shown only once, so this is a two-step dialog:
 * register → reveal command (the dialog stays open on the command screen).
 */
export function AddServer() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [command, setCommand] = React.useState<string | null>(null);

  function reset() {
    setName("");
    setHost("");
    setCommand(null);
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
        { input: { name, host } },
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
          Add remote server
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
              ? "Run this once on the server. It installs Docker (if needed) and the Deplo agent, which then calls home to finish provisioning."
              : "Register the host, then run the install command it gives you on the box. Deplo never SSHes in — the agent connects out to this control plane."}
          </DialogDescription>
        </DialogHeader>

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
              <Label htmlFor="srv-host">Host or IP</Label>
              <Input
                id="srv-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="203.0.113.24"
                className="font-mono text-sm"
              />
              <p className="text-muted-foreground text-xs">
                The address this control plane will reach the agent at, and where
                deployed apps for this server will be routed.
              </p>
            </div>
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
              <Button onClick={submit} disabled={pending || !host.trim()}>
                {pending ? "Registering…" : "Register server"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

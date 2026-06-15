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
import { addServerAction } from "@/lib/actions/servers";

export function AddServer({ installCommand }: { installCommand: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [sshUser, setSshUser] = React.useState("root");
  const [sshPort, setSshPort] = React.useState("22");

  function submit() {
    startTransition(async () => {
      const res = await addServerAction({
        name,
        host,
        sshUser: sshUser || undefined,
        sshPort: Number(sshPort) || 22,
      });
      if (res.ok) {
        toast.success(`Connecting to ${name || host}…`);
        setOpen(false);
        setName("");
        setHost("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
            Deplo connects over SSH and installs Docker, Traefik and the agent
            automatically. Provide a server reachable from this host.
          </DialogDescription>
        </DialogHeader>
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
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="srv-user">SSH user</Label>
              <Input
                id="srv-user"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="srv-port">SSH port</Label>
              <Input
                id="srv-port"
                type="number"
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Or install manually on the server</Label>
            <CommandLine command={installCommand} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !host.trim()}>
            {pending ? "Connecting…" : "Connect server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

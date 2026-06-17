"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CodeBlock } from "@/components/shared/code-block";
import { addDomainAction } from "@/lib/actions/domains";

export function AddDomain({
  projects,
  defaultProjectId,
  composeProjectIds = [],
}: {
  projects: { id: string; name: string }[];
  defaultProjectId?: string;
  /** Project ids that route via a compose stack — per-domain ports don't apply
   * there, so the port field is hidden when one of these is selected. */
  composeProjectIds?: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [projectId, setProjectId] = React.useState(
    defaultProjectId ?? projects[0]?.id ?? "",
  );
  const [name, setName] = React.useState("");
  // Optional container-port override. Blank ⇒ route to the project's default
  // port (the long-standing behaviour). A value here gives this host its own
  // Traefik router, so one container can serve different services per domain.
  const [port, setPort] = React.useState("");

  // Per-domain ports don't apply to compose stacks (they route per-service via
  // the compose file), so hide the field — and never send a port — for those.
  const portConfigurable = !composeProjectIds.includes(projectId);

  function submit() {
    const trimmed = portConfigurable ? port.trim() : "";
    const portNum = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isInteger(portNum) || portNum! < 1 || portNum! > 65535)) {
      toast.error("Port must be between 1 and 65535");
      return;
    }
    startTransition(async () => {
      const res = await addDomainAction({ projectId, name, port: portNum });
      if (res.ok) {
        toast.success("Domain added — configure DNS to verify");
        setOpen(false);
        setName("");
        setPort("");
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={projects.length === 0}>
          <Plus className="size-4" />
          Add Domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>
            Point a custom domain at one of your projects. Deplo issues TLS
            automatically via Let&apos;s Encrypt.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="domain-name">Domain</Label>
            <Input
              id="domain-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="app.example.com"
              className="font-mono text-sm"
            />
          </div>
          {portConfigurable && (
            <div className="space-y-2">
              <Label htmlFor="domain-port">
                Service port{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="domain-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="Default port"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                The container port this domain routes to. Leave blank to use the
                project&apos;s default port.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Add this DNS record at your provider
            </Label>
            <CodeBlock
              code={`A     ${name || "app.example.com"}     →   <your-server-ip>`}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !name.trim() || !projectId}
          >
            {pending ? "Adding…" : "Add domain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

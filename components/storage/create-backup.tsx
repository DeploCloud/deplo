"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";

type TargetKind = "database" | "project";

export function CreateBackup({
  databases,
  projects = [],
  destinations,
  autoOpen = false,
}: {
  databases: { id: string; name: string }[];
  projects?: { id: string; name: string }[];
  destinations: { id: string; name: string }[];
  /** Open on mount — used by the global "New ▸ Schedule backup" menu
   *  (which links to /storage?new=backup). */
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen);
  const [pending, startTransition] = React.useTransition();

  // Drop the ?new=backup param after opening so a refresh/Back doesn't reopen it.
  React.useEffect(() => {
    if (autoOpen) router.replace("/storage", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [name, setName] = React.useState("");
  // Default to whichever target type actually has options — a team with only
  // projects (no databases) should land on "Project" rather than an empty select.
  const [targetKind, setTargetKind] = React.useState<TargetKind>(
    databases.length === 0 && projects.length > 0 ? "project" : "database"
  );
  const [databaseId, setDatabaseId] = React.useState<string>(
    databases[0]?.id ?? ""
  );
  const [projectId, setProjectId] = React.useState<string>(
    projects[0]?.id ?? ""
  );
  const [destinationId, setDestinationId] = React.useState<string>(
    destinations[0]?.id ?? ""
  );
  const [schedule, setSchedule] = React.useState("0 3 * * *");
  const [retention, setRetention] = React.useState(14);

  const noDeps = destinations.length === 0;
  // The chosen target must have a concrete id selected — otherwise the schedule
  // would point at nothing.
  const targetId = targetKind === "database" ? databaseId : projectId;

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateBackupInput!) { createBackup(input: $input) }`,
        {
          input: {
            name,
            targetKind,
            databaseId: targetKind === "database" ? databaseId || null : null,
            projectId: targetKind === "project" ? projectId || null : null,
            destinationId,
            schedule,
            retentionDays: retention,
          },
        }
      );
      if (res.ok) {
        toast.success("Backup schedule created");
        setOpen(false);
        setName("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          {noDeps ? (
            // Disabled buttons swallow pointer events, so wrap in a focusable
            // span to keep the tooltip reachable. No DialogTrigger here means a
            // click can never open the dialog while dependencies are missing.
            <span tabIndex={0}>
              <Button size="sm" disabled>
                <Plus className="size-4" />
                New Backup
              </Button>
            </span>
          ) : (
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />
                New Backup
              </Button>
            </DialogTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {noDeps ? "Add an S3 destination first" : "Schedule a backup"}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a backup</DialogTitle>
          <DialogDescription>
            Periodically back up a database or a project to an S3 destination.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly Postgres backup"
            />
          </div>
          {/* Target-kind toggle: a schedule backs up either a database or a
              whole project (volumes + files + compose/env snapshot). */}
          <div className="space-y-2">
            <Label>Target</Label>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
              <Button
                type="button"
                size="sm"
                variant={targetKind === "database" ? "secondary" : "ghost"}
                onClick={() => setTargetKind("database")}
              >
                Database
              </Button>
              <Button
                type="button"
                size="sm"
                variant={targetKind === "project" ? "secondary" : "ghost"}
                onClick={() => setTargetKind("project")}
              >
                Project
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              {targetKind === "database" ? (
                <>
                  <Label>Database</Label>
                  <Select value={databaseId} onValueChange={setDatabaseId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {databases.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <Label>Project</Label>
                  <Select value={projectId} onValueChange={setProjectId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
            <div className="space-y-2">
              <Label>Destination</Label>
              <Select value={destinationId} onValueChange={setDestinationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <SimpleTooltip content="Standard cron expression (UTC)">
                <Label className="cursor-help underline decoration-dotted underline-offset-4">
                  Schedule (cron)
                </Label>
              </SimpleTooltip>
              <Input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label>Retention (days)</Label>
              <Input
                type="number"
                value={retention}
                onChange={(e) => setRetention(Number(e.target.value) || 7)}
                min={1}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !name.trim() || !destinationId || !targetId}
          >
            {pending ? "Creating…" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

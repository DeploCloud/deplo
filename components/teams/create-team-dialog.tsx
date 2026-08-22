"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { gqlAction } from "@/lib/graphql-client";
import type { Team } from "@/lib/types";

/**
 * Create a new team — the viewer becomes its owner and it is made active.
 * Controlled (no trigger of its own) so it can be opened from a menu, the team
 * switcher, or anywhere else.
 */
export function CreateTeamDialog({
  open,
  onOpenChange,
  redirect = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /**
   * Whether to leave for the overview once the team exists. True everywhere a
   * new team is the whole errand; false when the caller is mid-flow and has
   * state of its own that a navigation would throw away - the migration wizard
   * holds a scan, a selection and an API key that exist only in its tab.
   */
  redirect?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    create();
  }

  function create() {
    startTransition(async () => {
      const res = await gqlAction<{ createTeam: Team }, Team>(
        `mutation($name: String!) { createTeam(name: $name) { id } }`,
        { name },
        (d) => d.createTeam,
      );
      if (res.ok) {
        toast.success("Team created");
        onOpenChange(false);
        setName("");
        if (redirect) router.push("/");
        // Either way: `createTeam` switches the active team server-side, so
        // every read on the page behind this dialog is now about a different
        // team and has to run again.
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setName("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new team</DialogTitle>
          <DialogDescription>
            A team is an isolated workspace for apps, domains, databases and
            members. You&apos;ll be its owner and it becomes your active team.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="new-team-name">Team name</Label>
            <Input
              id="new-team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create team"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

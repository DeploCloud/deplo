"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { DocsLink } from "@/components/ui/docs-link";

/**
 * Create a new team - the viewer becomes its owner and it is made active.
 * Controlled (no trigger of its own) so it can be opened from a menu, the team
 * switcher, or anywhere else.
 */
export function CreateTeamDialog({
  open,
  onOpenChange,
  redirect = true,
  onCreated,
  defaultName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /**
   * Whether to leave for the overview once the team exists. False when the
   * caller is mid-flow with state a navigation would throw away - the migration
   * wizard holds a scan and an API key that exist only in its tab. */
  redirect?: boolean;
  /** Fired with the new team's id once it exists and is active - for a caller
   *  that has to react to landing in a different team. */
  onCreated?: (teamId: string) => void;
  /** What the field opens with - the source team's name, when a migration is
   *  creating the team that mirrors it. */
  defaultName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Back to the seed rather than to empty, so a dialog that stays mounted still
  // opens on the name its caller gave it.
  const [name, setName] = React.useState(defaultName ?? "");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    create();
  }

  function create() {
    startTransition(async () => {
      const res = await gqlAction<{ createTeam: Team }, Team>(
        `mutation($name: String!) { createTeam(name: $name) { id slug } }`,
        { name },
        (d) => d.createTeam,
      );
      if (res.ok) {
        toast.success("Team created");
        onOpenChange(false);
        setName(defaultName ?? "");
        // Into the new team, by name: the team a page shows IS its address, so
        // landing on `/` would just put the old one back.
        if (redirect && res.data) router.push(`/${res.data.slug}`);
        // Either way: `createTeam` switches the active team server-side, so
        // every read on the page behind this dialog is now about a different
        // team and has to run again.
        router.refresh();
        if (res.data) onCreated?.(res.data.id);
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
        if (!o) setName(defaultName ?? "");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new team</DialogTitle>
          <DialogDescription>
            An isolated workspace for apps, domains, databases and members.{" "}
            <strong>You&apos;ll be its owner.</strong>{" "}
            <DocsLink topic="team.overview" />
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
              {pending && <Loader2 className="size-4 animate-spin" />}
              Create team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

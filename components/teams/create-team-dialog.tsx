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
import type { Team } from "@/lib/types/team";
import { DocsLink } from "@/components/ui/docs-link";

// CreateTeamDialog - creates a team the viewer owns and makes it the active team.
export function CreateTeamDialog({
  open,
  onOpenChange,
  redirect = true,
  onCreated,
  defaultName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  // False when the caller holds state a navigation would lose (the migration wizard's scan + API key).
  redirect?: boolean;
  onCreated?: (teamId: string) => void;
  defaultName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Back to the seed, not to empty: a dialog that stays mounted reopens on its caller's name.
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
        // The team a page shows IS its address, so landing on `/` puts the old one back.
        if (redirect && res.data) router.push(`/${res.data.slug}`);
        // `createTeam` switches the active team server-side, so the page behind must re-read.
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

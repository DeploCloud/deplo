"use client";

import * as React from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { updateTeamAction } from "@/lib/actions/teams";

export function TeamForm({
  name: initialName,
  slug: initialSlug,
}: {
  name: string;
  slug: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState(initialName);
  const [slug, setSlug] = React.useState(initialSlug);

  const dirty =
    name.trim() !== initialName || slug.trim() !== initialSlug;

  function save() {
    startTransition(async () => {
      const res = await updateTeamAction({ name, slug });
      if (res.ok) toast.success("Team updated");
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="team-name">Team name</Label>
          <Input
            id="team-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="team-slug">Slug</Label>
          <Input
            id="team-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={pending || !dirty || !name.trim() || !slug.trim()}
        >
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

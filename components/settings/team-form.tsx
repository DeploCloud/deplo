"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";

export function TeamForm({
  name: initialName,
  slug: initialSlug,
  canManage = true,
}: {
  name: string;
  slug: string;
  canManage?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState(initialName);
  const [slug, setSlug] = React.useState(initialSlug);

  const dirty =
    name.trim() !== initialName || slug.trim() !== initialSlug;

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: UpdateTeamInput!) { updateTeam(input: $input) { id } }`,
        { input: { name, slug } }
      );
      if (res.ok) {
        toast.success("Team updated");
        router.refresh();
      } else toast.error(res.error);
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
            disabled={!canManage}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="team-slug">Slug</Label>
          <Input
            id="team-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono text-sm"
            disabled={!canManage}
          />
        </div>
      </div>
      {canManage && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={save}
            disabled={pending || !dirty || !name.trim() || !slug.trim()}
          >
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

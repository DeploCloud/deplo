"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { Button } from "@/components/ui/button";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { AvatarPicker } from "@/components/shared/avatar-picker";
import { gqlAction } from "@/lib/graphql-client";

export function TeamForm({
  name: initialName,
  slug: initialSlug,
  avatarUrl,
  canManage = true,
}: {
  name: string;
  slug: string;
  avatarUrl: string | null;
  canManage?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [name, setName] = React.useState(initialName);
  const [slug, setSlug] = React.useState(initialSlug);

  const dirty = name.trim() !== initialName || slug.trim() !== initialSlug;

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: UpdateTeamInput!) { updateTeam(input: $input) { id } }`,
        { input: { name, slug } },
      );
      if (res.ok) {
        toast.success("Team updated");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const teamMark = (
    <TeamAvatar name={initialName} avatarUrl={avatarUrl} size="2xl" />
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {canManage ? (
          <AvatarPicker
            label="Change the team picture"
            hasImage={Boolean(avatarUrl)}
            preview={teamMark}
            onSave={(image) =>
              gqlAction(
                `mutation($image: String) { updateTeamAvatar(image: $image) { id } }`,
                { image },
              )
            }
          />
        ) : (
          teamMark
        )}
        <div>
          <p className="text-sm font-medium">Team picture</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Shown before the team&apos;s name everywhere it appears.
          </p>
        </div>
      </div>
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
          <FieldLabel
            htmlFor="team-slug"
            info="URL-safe id used in links and to seed the names of installed app containers. Lowercase letters, numbers and hyphens."
            docs="team.overview"
          >
            Slug
          </FieldLabel>
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
            disabled={!dirty || !name.trim() || !slug.trim()}
          >
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

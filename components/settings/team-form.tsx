"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { AvatarPicker } from "@/components/shared/avatar-picker";
import {
  avatarChoiceFromUrl,
  avatarSeedFromName,
} from "@/lib/apps/avatar-shared";
import { gqlAction } from "@/lib/graphql-client";

export function TeamForm({
  name: initialName,
  avatarUrl,
  canManage = true,
}: {
  name: string;
  avatarUrl: string | null;
  canManage?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [name, setName] = React.useState(initialName);

  const dirty = name.trim() !== initialName;

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: UpdateTeamInput!) { updateTeam(input: $input) { id } }`,
        { input: { name } },
      );
      if (res.ok) {
        toast.success("Team updated");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const teamMark = (
    <TeamAvatar name={initialName} avatarUrl={avatarUrl} size="3xl" />
  );
  const pictureText = (
    <div>
      <p className="text-base font-medium">Team picture</p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {canManage
          ? "Click the picture or drop an image on it. PNG, JPEG or WebP."
          : "Shown before the team's name everywhere it appears."}
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      {canManage ? (
        <AvatarPicker
          label="Change the team picture"
          hasImage={Boolean(avatarUrl)}
          sources={{
            team: true,
            choice: avatarChoiceFromUrl(avatarUrl),
            // The SAVED name, like the picture beside it: the field is editable
            // and the letters must not drift as it is typed.
            letters: avatarSeedFromName(initialName),
          }}
          preview={teamMark}
          onSave={(image) =>
            gqlAction(
              `mutation($image: String) { updateTeamAvatar(image: $image) { id } }`,
              { image },
            )
          }
        >
          {pictureText}
        </AvatarPicker>
      ) : (
        <div className="flex items-center gap-4">
          {teamMark}
          {pictureText}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="team-name">Team name</Label>
        <Input
          id="team-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage}
        />
      </div>
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={!dirty || !name.trim()}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

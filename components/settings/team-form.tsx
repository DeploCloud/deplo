"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
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
    <TeamAvatar name={initialName} avatarUrl={avatarUrl} size="4xl" />
  );

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 py-2">
        {canManage ? (
          <div className="w-fit">
            <AvatarPicker
              label="Change the team picture"
              hasImage={Boolean(avatarUrl)}
              sources={{
                team: true,
                choice: avatarChoiceFromUrl(avatarUrl),
                letters: avatarSeedFromName(initialName),
              }}
              preview={teamMark}
              onSave={(image) =>
                gqlAction(
                  `mutation($image: String) { updateTeamAvatar(image: $image) { id } }`,
                  { image },
                )
              }
            />
          </div>
        ) : (
          teamMark
        )}
        <p className="text-center text-xs text-muted-foreground">
          {canManage
            ? "Click or drop a PNG, JPEG or WebP."
            : "Shown before the team's name everywhere it appears."}
        </p>
      </div>
      <div className="space-y-2 rounded-lg border border-border p-3">
        <Label htmlFor="team-name">Team name</Label>
        <div className="flex gap-2">
          <Input
            id="team-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canManage}
            className="min-w-0 flex-1"
          />
          {canManage && (
            <Button onClick={save} disabled={!dirty || !name.trim()}>
              Save changes
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

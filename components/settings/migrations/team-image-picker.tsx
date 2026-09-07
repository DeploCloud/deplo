"use client";

import { AvatarPicker } from "@/components/shared/avatar-picker";
import { TeamAvatar } from "@/components/shared/user-avatar";
import {
  avatarChoiceFromValue,
  avatarPreviewUrl,
  avatarSeedFromName,
} from "@/lib/apps/avatar-shared";

/**
 * The picture a team being imported will be created with. Held, not saved -
 * the team does not exist yet, so this is the onboarding wizard's `quiet` mode.
 * No panel's own team picture is read: only one of the two keeps one.
 */
export function TeamImagePicker({
  name,
  image,
  onChange,
  disabled,
}: {
  name: string;
  /** Null is the team's initials, which is where every import starts. */
  image: string | null;
  onChange: (image: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <AvatarPicker
      quiet
      disabled={disabled}
      label={`Picture for ${name}`}
      hasImage={Boolean(image)}
      sources={{
        team: true,
        choice: avatarChoiceFromValue(image),
        letters: avatarSeedFromName(name),
      }}
      onSave={async (next) => {
        onChange(next);
        return { ok: true };
      }}
      preview={
        <TeamAvatar name={name} avatarUrl={avatarPreviewUrl(image)} size="sm" />
      }
    />
  );
}

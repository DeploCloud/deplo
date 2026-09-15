"use client";

import { AvatarPicker } from "@/components/shared/avatar-picker";
import { TeamAvatar } from "@/components/shared/user-avatar";
import {
  avatarChoiceFromValue,
  avatarPreviewUrl,
  avatarSeedFromName,
} from "@/lib/apps/avatar-shared";

export function TeamImagePicker({
  name,
  image,
  onChange,
  disabled,
}: {
  name: string;
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

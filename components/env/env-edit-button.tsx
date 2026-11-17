"use client";

import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

export const SECRET_EDIT_BLOCKED =
  "Secrets cannot be edited. Delete and add it again.";

export const SECRET_NOTE_ONLY =
  "A secret's value can't be edited, only its note. Delete it and add it again to change the value.";

// On a secret only the note is editable, so the button stays live and says so.
export function EnvEditButton({
  secret,
  onClick,
  label = "Edit",
  tooltip,
  disabled,
}: {
  secret: boolean;
  onClick: () => void;
  label?: string;
  tooltip?: string;
  disabled?: boolean;
}) {
  const blocked = Boolean(disabled);
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={blocked}
      onClick={blocked ? undefined : onClick}
      aria-label={secret ? "Edit note" : label}
    >
      <Pencil className="size-4" />
    </Button>
  );
  const content = secret ? SECRET_NOTE_ONLY : tooltip;
  if (!content) return button;
  return (
    <SimpleTooltip content={content}>
      <span className="inline-flex">{button}</span>
    </SimpleTooltip>
  );
}

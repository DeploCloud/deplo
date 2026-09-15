"use client";

import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

export const SECRET_EDIT_BLOCKED =
  "Secrets cannot be edited. Delete and add it again.";

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
  const blocked = secret || Boolean(disabled);
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={blocked}
      onClick={blocked ? undefined : onClick}
      aria-label={label}
    >
      <Pencil className="size-4" />
    </Button>
  );
  const content = secret ? SECRET_EDIT_BLOCKED : tooltip;
  if (!content) return button;
  return (
    <SimpleTooltip content={content}>
      <span className="inline-flex">{button}</span>
    </SimpleTooltip>
  );
}

"use client";

import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

/** The refusal, in the UI's words. The server raises the same sentence. */
export const SECRET_EDIT_BLOCKED =
  "Secrets cannot be edited. Delete and add it again.";

/**
 * The pencil every variable table shows, and the ONE place that decides a secret
 * does not get one. A secret is write-only.
 */
export function EnvEditButton({
  secret,
  onClick,
  label = "Edit",
  tooltip,
  disabled,
}: {
  /** The row is a secret: no edit, ever, and the tooltip says why. */
  secret: boolean;
  onClick: () => void;
  label?: string;
  /** Tooltip for a row that CAN be edited. A secret always explains itself. */
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

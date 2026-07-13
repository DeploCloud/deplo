import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { VarAuthor } from "@/lib/types";

/**
 * The "Modified by" cell of a variables table. `null` — a deleted account, or a
 * row written before authorship was tracked (migration 0029 does not backfill) —
 * renders an em dash rather than a fabricated name.
 *
 * Identity only: the author is metadata, never part of the (masked) value.
 */
export function EnvAuthorCell({ author }: { author: VarAuthor | null }) {
  if (!author) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const name = author.name.trim();
  return (
    <SimpleTooltip content={name ? `${name} (@${author.username})` : `@${author.username}`}>
      <span className="flex w-fit items-center gap-2">
        <Avatar className="size-5">
          <AvatarFallback
            className="text-[9px]"
            style={{ backgroundColor: author.avatarColor, color: "#000" }}
          >
            {author.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-xs">@{author.username}</span>
      </span>
    </SimpleTooltip>
  );
}

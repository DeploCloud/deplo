import { UserAvatar } from "@/components/shared/user-avatar";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { VarAuthor } from "@/lib/types";

/**
 * The "Modified by" cell of a variables table. `null` - a deleted account, or a
 * row written before authorship was tracked (migration 0029 does not backfill) -
 * renders an em dash rather than a fabricated name.
 */
export function EnvAuthorCell({ author }: { author: VarAuthor | null }) {
  if (!author) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const name = author.name.trim();
  return (
    <SimpleTooltip
      content={name ? `${name} (@${author.username})` : `@${author.username}`}
    >
      <span className="flex w-fit items-center gap-2">
        <UserAvatar
          name={author.name}
          username={author.username}
          avatarUrl={author.avatarUrl}
          size="sm"
        />
        <span className="truncate text-xs">@{author.username}</span>
      </span>
    </SimpleTooltip>
  );
}

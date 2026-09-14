import { cn } from "@/lib/utils";

// ServerRoleHint - said on BOTH states, so the contrast is the message rather than a lone badge.
export function ServerRoleHint({
  isDeploHost,
  className,
}: {
  isDeploHost?: boolean;
  className?: string;
}) {
  return (
    <span data-hint className={cn("text-xs text-muted-foreground", className)}>
      {isDeploHost ? "Deplo host" : "Remote"}
    </span>
  );
}

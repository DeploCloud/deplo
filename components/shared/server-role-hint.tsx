import { cn } from "@/lib/utils";

/**
 * Which machine a row is, in every picker that asks for a server: the host running
 * Deplo itself, or a remote that only runs the deploy agent. Said on BOTH, so the
 * contrast is the message rather than a lone badge you have to know is missing.
 */
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

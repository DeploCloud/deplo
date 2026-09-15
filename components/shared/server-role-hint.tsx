import { cn } from "@/lib/utils";

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

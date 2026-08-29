import { GitProviderIcon } from "@/components/shared/brand-icons";
import type { AvatarSize } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";

/** The host's mark, a step under the avatar it stands in for. */
const MARK: Partial<Record<AvatarSize, string>> = {
  xs: "size-3.5",
  sm: "size-4",
};

/**
 * An account on a git host: its mark, its login, and the profile behind it. The
 * ONE way a pusher is drawn - a deployment, the trail and a pull request all come
 * here, so a login can never be mistaken for a member of the team.
 */
export function GitAccount({
  login,
  provider,
  url,
  size = "sm",
  className,
}: {
  login: string;
  /** Which host: `github`, `gitlab`, `bitbucket`, `gitea`. */
  provider: string;
  /** The profile, when it can be linked (see `gitProfileUrl`). */
  url?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const body = (
    <>
      <GitProviderIcon
        provider={provider}
        className={cn("shrink-0", MARK[size] ?? "size-4")}
      />
      {/* Same affordance the commit sha carries: a dotted underline is how this
          product says "this opens the git host". */}
      <span
        className={cn(
          "truncate",
          url && "underline decoration-dotted underline-offset-2",
        )}
      >
        {login}
      </span>
    </>
  );
  const cls = cn("flex min-w-0 items-center gap-1.5", className);
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(cls, "transition-colors hover:text-foreground")}
    >
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

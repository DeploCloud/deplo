import { GitAccount } from "@/components/shared/git-account";
import { UserAvatar, type AvatarSize } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";

/**
 * Who ran a deployment: a member here, drawn with their own face, or the account
 * that pushed, drawn as {@link GitAccount} - never a monogram for somebody this
 * instance has no user for.
 */
export function DeploymentCreator({
  creator,
  creatorUser,
  creatorProvider,
  creatorUrl,
  size = "sm",
  className,
}: {
  creator: string;
  creatorUser?: {
    name: string;
    username: string;
    avatarColor: string;
    avatarUrl: string | null;
  } | null;
  /** Set ⇒ `creator` is a login on this git host, not a deplo account. */
  creatorProvider?: string | null;
  /** That account's profile, when it can be linked. */
  creatorUrl?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  if (creatorProvider)
    return (
      <GitAccount
        login={creator}
        provider={creatorProvider}
        url={creatorUrl}
        size={size}
        className={className}
      />
    );
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <UserAvatar
        name={creatorUser?.name ?? creator}
        username={creatorUser?.username}
        avatarColor={creatorUser?.avatarColor}
        avatarUrl={creatorUser?.avatarUrl}
        size={size}
      />
      <span className="truncate">{creator}</span>
    </span>
  );
}

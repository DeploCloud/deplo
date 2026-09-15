import { GitAccount } from "@/components/shared/git-account";
import { UserAvatar, type AvatarSize } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";

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
  creatorProvider?: string | null;
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
        avatarUrl={creatorUser?.avatarUrl}
        size={size}
      />
      <span className="truncate">{creator}</span>
    </span>
  );
}

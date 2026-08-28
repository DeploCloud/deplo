import { GitProviderIcon } from "@/components/shared/brand-icons";
import { UserAvatar, type AvatarSize } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";

/** The host's mark, a step under the avatar it stands in for. */
const MARK: Partial<Record<AvatarSize, string>> = {
  xs: "size-3.5",
  sm: "size-4",
};

/**
 * Who ran a deployment. A webhook push credits an account on the git host, so it
 * gets that host's mark and a link to the profile - never a monogram for somebody
 * this instance has no user for.
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
  const body = (
    <>
      {creatorProvider ? (
        <GitProviderIcon
          provider={creatorProvider}
          className={cn("shrink-0", MARK[size] ?? "size-4")}
        />
      ) : (
        <UserAvatar
          name={creatorUser?.name ?? creator}
          username={creatorUser?.username}
          avatarColor={creatorUser?.avatarColor}
          avatarUrl={creatorUser?.avatarUrl}
          size={size}
        />
      )}
      <span className="truncate">{creator}</span>
    </>
  );
  const cls = cn("flex min-w-0 items-center gap-1.5", className);
  return creatorProvider && creatorUrl ? (
    <a
      href={creatorUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(cls, "hover:underline")}
    >
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

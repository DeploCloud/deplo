import { GitProviderIcon } from "@/components/shared/brand-icons";
import type { AvatarSize } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";

const MARK: Partial<Record<AvatarSize, string>> = {
  xs: "size-3.5",
  sm: "size-4",
};

export function GitAccount({
  login,
  provider,
  url,
  size = "sm",
  className,
}: {
  login: string;
  provider: string;
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

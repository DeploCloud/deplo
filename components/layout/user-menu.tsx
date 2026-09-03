"use client";

import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import {
  LogOut,
  User as UserIcon,
  Fingerprint,
  KeyRound,
  BookOpen,
  ExternalLink,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/shared/user-avatar";
import { DiscordIcon, GitHubIcon } from "@/components/shared/brand-icons";
import { gqlAction } from "@/lib/graphql-client";
import { DISCORD_URL, GITHUB_URL } from "@/lib/links";
import { docsUrl } from "@/lib/docs";
import type { PublicUser } from "@/lib/types";

/** The account's own settings - the same three the Settings sidebar groups under "Account". */
const ACCOUNT_LINKS = [
  { href: "/settings/account", icon: UserIcon, label: "Account" },
  { href: "/settings/security", icon: Fingerprint, label: "Security" },
  { href: "/settings/tokens", icon: KeyRound, label: "API tokens" },
];

/** The manual, the room where questions get answered, and the source. */
const EXTERNAL_LINKS = [
  { href: docsUrl("docs.home"), icon: BookOpen, label: "Documentation" },
  { href: DISCORD_URL, icon: DiscordIcon, label: "Discord" },
  { href: GITHUB_URL, icon: GitHubIcon, label: "GitHub" },
];

export function UserMenu({ user }: { user: PublicUser }) {
  const router = useRouter();

  async function handleLogout() {
    await gqlAction(`mutation { logout }`);
    router.push("/login");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Account menu"
        >
          <UserAvatar
            name={user.name}
            username={user.username}
            avatarUrl={user.avatarUrl}
            size="lg"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem asChild className="gap-3 py-2">
          <Link href="/settings/account" className="cursor-pointer">
            <UserAvatar
              name={user.name}
              username={user.username}
              avatarUrl={user.avatarUrl}
              size="xl"
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {user.name || user.username}
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                @{user.username}
              </span>
            </div>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {ACCOUNT_LINKS.map(({ href, icon: Icon, label }) => (
          <DropdownMenuItem key={href} asChild>
            <Link href={href} className="cursor-pointer">
              <Icon className="size-4" />
              {label}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {EXTERNAL_LINKS.map(({ href, icon: Icon, label }) => (
          <DropdownMenuItem key={href} asChild>
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer"
            >
              <Icon className="size-4" />
              {label}
              <ExternalLink className="ml-auto size-4 text-muted-foreground" />
            </a>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          className="cursor-pointer"
          onSelect={(e) => {
            e.preventDefault();
            void handleLogout();
          }}
        >
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

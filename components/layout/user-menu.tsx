"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LogOut,
  User as UserIcon,
  Fingerprint,
  KeyRound,
  BookOpen,
  ExternalLink,
  Pencil,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { avatarInitials, UserAvatar } from "@/components/shared/user-avatar";
import { AvatarPicker } from "@/components/shared/avatar-picker";
import { avatarChoiceFromUrl } from "@/lib/apps/avatar-shared";
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

export function UserMenu({
  user,
  gravatar,
}: {
  user: PublicUser;
  /** Their Gravatar address, or null where the instance keeps it off. */
  gravatar?: string | null;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);

  async function handleLogout() {
    await gqlAction(`mutation { logout }`);
    router.push("/login");
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
          <DropdownMenuLabel className="flex items-center gap-3 py-2">
            <button
              type="button"
              aria-label="Change your picture"
              className="group relative shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setMenuOpen(false);
                // After the menu has gone: two overlays mounting in the same
                // tick is what leaves `pointer-events: none` on the body.
                requestAnimationFrame(() => setEditing(true));
              }}
            >
              <UserAvatar
                name={user.name}
                username={user.username}
                avatarUrl={user.avatarUrl}
                size="xl"
              />
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/70 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                <Pencil className="size-3.5 text-foreground" />
              </span>
            </button>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {user.name || user.username}
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                @{user.username}
              </span>
            </div>
          </DropdownMenuLabel>
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
      {/* OUTSIDE the menu on purpose: a dialog rendered inside `DropdownMenuContent`
        unmounts with it the moment the menu closes. */}
      <AvatarPicker
        controlled={{ open: editing, onOpenChange: setEditing }}
        preload={menuOpen || editing}
        sources={{
          choice: avatarChoiceFromUrl(user.avatarUrl),
          seed: user.id,
          letters: avatarInitials(user.name, user.username),
          gravatar,
        }}
        onSave={(image) =>
          gqlAction(
            `mutation($image: String) { updateMyAvatar(image: $image) }`,
            { image },
          )
        }
      />
    </>
  );
}

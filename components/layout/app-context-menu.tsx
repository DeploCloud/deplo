"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  CalendarClock,
  Database,
  HardDrive,
  House,
  KeyRound,
  Moon,
  Plus,
  RotateCw,
  Rocket,
  Server,
  Sun,
  UserCog,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuSubTooltip, SimpleTooltip } from "@/components/ui/tooltip";
import { useTheme } from "@/components/theme-provider";

interface NewItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

/**
 * The page-contextual "New ▸" entries for the current route. Each links to the
 * destination page with the same `?new=…` open-param convention `AddNewMenu`
 * already uses (`/storage?new=database`), so the target page auto-opens its
 * create dialog. "New project" is the universal baseline shown everywhere.
 */
function newItemsFor(
  pathname: string,
  caps: { canManageMembers: boolean; isAdmin: boolean },
): NewItem[] {
  const project: NewItem = { label: "New project", href: "/new", icon: Rocket };
  const database: NewItem = {
    label: "New database",
    href: "/storage?new=database",
    icon: Database,
  };

  if (pathname.startsWith("/storage")) {
    return [
      database,
      { label: "New S3 destination", href: "/storage?new=s3", icon: HardDrive },
      { label: "Schedule backup", href: "/storage?new=backup", icon: CalendarClock },
    ];
  }
  if (pathname.startsWith("/settings/servers")) {
    return [{ label: "Add server", href: "/settings/servers?new=1", icon: Server }, project];
  }
  if (pathname.startsWith("/settings/tokens")) {
    return [{ label: "API tokens", href: "/settings/tokens", icon: KeyRound }, project];
  }
  if (pathname.startsWith("/settings/registries")) {
    return [{ label: "Registries", href: "/settings/registries", icon: Boxes }, project];
  }
  if (pathname.startsWith("/settings/users")) {
    return caps.isAdmin
      ? [{ label: "Manage users", href: "/settings/users", icon: UserCog }, project]
      : [project];
  }
  if (pathname.startsWith("/members")) {
    return caps.canManageMembers
      ? [{ label: "Team members", href: "/members", icon: UserPlus }, project]
      : [project];
  }
  // Overview, deployments, domains, apps, templates, monitoring, activity, …
  return [project, database];
}

/** True for surfaces where the user expects the BROWSER's native menu (cut /
 *  copy / paste, terminal copy): editable fields and anything opting out with
 *  `data-native-context`. The global menu steps aside there. */
function wantsNativeMenu(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el?.closest?.(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-native-context]",
    ),
  );
}

/**
 * App-wide right-click menu. Wraps the whole shell so EVERY page gets a
 * contextual menu — replacing the browser's native menu on general surfaces
 * (it is left alone on editable/terminal surfaces, see {@link wantsNativeMenu}).
 * Per-item menus (project/folder/database/… cards) and the Overview canvas menu
 * nest inside and intercept the `contextmenu` event first, so this opens only on
 * otherwise-empty space — exactly the contextual behaviour we want.
 */
export function AppContextMenu({
  capabilities,
  isAdmin,
  children,
}: {
  capabilities: string[];
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  // Let the native menu through on editable/terminal surfaces. A capture-phase
  // listener stops the event before it reaches Radix's trigger handler (so Radix
  // neither opens our menu nor preventDefaults), leaving the browser menu intact.
  React.useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const onCtx = (e: MouseEvent) => {
      if (wantsNativeMenu(e.target)) e.stopPropagation();
    };
    node.addEventListener("contextmenu", onCtx, true);
    return () => node.removeEventListener("contextmenu", onCtx, true);
  }, []);

  const newItems = newItemsFor(pathname, {
    canManageMembers: capabilities.includes("manage_members"),
    isAdmin,
  });
  const isDark = resolvedTheme === "dark";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={wrapRef} className="contents">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <MenuSubTooltip
          Sub={ContextMenuSub}
          SubTrigger={ContextMenuSubTrigger}
          SubContent={ContextMenuSubContent}
          content="Create something new"
          subContentClassName="w-52"
          trigger={
            <>
              <Plus className="size-4" />
              New
            </>
          }
        >
          {newItems.map((item) => (
            <SimpleTooltip key={item.href} content={item.label} side="left">
              <ContextMenuItem asChild>
                <Link href={item.href} className="cursor-pointer">
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              </ContextMenuItem>
            </SimpleTooltip>
          ))}
        </MenuSubTooltip>

        <ContextMenuSeparator />

        <SimpleTooltip content="Go back to the previous page" side="left">
          <ContextMenuItem onSelect={() => router.back()}>
            <ArrowLeft className="size-4" />
            Back
          </ContextMenuItem>
        </SimpleTooltip>
        <SimpleTooltip content="Go forward" side="left">
          <ContextMenuItem onSelect={() => router.forward()}>
            <ArrowRight className="size-4" />
            Forward
          </ContextMenuItem>
        </SimpleTooltip>
        <SimpleTooltip content="Reload the latest data for this page" side="left">
          <ContextMenuItem onSelect={() => router.refresh()}>
            <RotateCw className="size-4" />
            Reload
          </ContextMenuItem>
        </SimpleTooltip>
        <SimpleTooltip content="Go to the services Overview" side="left">
          <ContextMenuItem asChild>
            <Link href="/" className="cursor-pointer">
              <House className="size-4" />
              Overview
            </Link>
          </ContextMenuItem>
        </SimpleTooltip>

        <ContextMenuSeparator />

        <SimpleTooltip content="Toggle light / dark appearance" side="left">
          <ContextMenuItem onSelect={() => setTheme(isDark ? "light" : "dark")}>
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {isDark ? "Light mode" : "Dark mode"}
          </ContextMenuItem>
        </SimpleTooltip>
      </ContextMenuContent>
    </ContextMenu>
  );
}

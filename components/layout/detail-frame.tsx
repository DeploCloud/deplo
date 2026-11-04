"use client";

import { ChevronLeft, Loader2 } from "lucide-react";
import Link from "@/components/ui/link";
import { useFullBleedRoute } from "@/components/layout/shell-frame";
import { useFlatPathname } from "@/lib/nav";
import { ALL_CAPABILITIES } from "@/lib/types/identity";
import type { AppNavState } from "@/components/apps/app-nav-store";
import { cn } from "@/lib/utils";
import { Card, NavRow } from "./mobile-rows";
import { backOutOf } from "./navigation-history";
import { useNavSections } from "./use-nav-sections";

// Below md an App or a database is a drill-down: its root lists the sections, each section leads back.
export interface MobileDetail {
  root: string;
  name: string;
  parent: { href: string; label: string };
  nav?: AppNavState;
}

export function DetailFrame({
  header,
  sidecars,
  locked = false,
  mobile,
  busy = false,
  children,
}: {
  header: React.ReactNode;
  sidecars?: React.ReactNode;
  locked?: boolean;
  mobile: MobileDetail;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const full = useFullBleedRoute();
  const pathname = useFlatPathname();
  const atRoot = pathname === mobile.root;
  const back = <MobileBack detail={mobile} atRoot={atRoot} />;

  if (full) {
    return (
      <div
        aria-busy={busy || undefined}
        className="flex min-h-0 w-full flex-1 flex-col"
      >
        {sidecars}
        <div className="px-4 md:hidden">{back}</div>
        {locked ? (
          <div inert className="flex min-h-0 flex-1 flex-col opacity-70">
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    );
  }

  return (
    <div
      aria-busy={busy || undefined}
      className="mx-auto w-full max-w-6xl space-y-6"
    >
      {sidecars}
      <div className="-mt-3 mb-1 md:hidden">{back}</div>
      {locked && <MigrationNotice />}
      <div
        inert={locked || undefined}
        className={cn("space-y-6", locked && "opacity-70")}
      >
        <div className={cn(!atRoot && "max-md:hidden")}>{header}</div>
        {atRoot && (
          <MobileSections root={mobile.root} nav={mobile.nav} busy={busy} />
        )}
        {children}
      </div>
    </div>
  );
}

function MobileBack({
  detail,
  atRoot,
}: {
  detail: MobileDetail;
  atRoot: boolean;
}) {
  const to = atRoot ? detail.parent : { href: detail.root, label: detail.name };
  return (
    <Link
      href={to.href}
      onClick={(e) => {
        if (atRoot && backOutOf(detail.root) !== "none") e.preventDefault();
      }}
      className="-ml-2 inline-flex h-11 max-w-full cursor-pointer items-center gap-0.5 text-base"
    >
      <ChevronLeft className="size-6 shrink-0 text-muted-foreground" />
      <span className="truncate">{to.label}</span>
    </Link>
  );
}

function MobileSections({
  root,
  nav,
  busy,
}: {
  root: string;
  nav?: AppNavState;
  busy: boolean;
}) {
  // Still loading, nothing names the member's Capabilities yet: draw the full menu.
  const { sections } = useNavSections(busy ? ALL_CAPABILITIES : [], false, nav);
  const items = sections
    .filter((s) => !s.backLink)
    .flatMap((s) => s.items)
    .filter((i) => i.href !== root);
  if (items.length === 0) return null;
  return (
    <Card className="md:hidden">
      {items.map((i) => (
        <NavRow key={i.href} item={i} />
      ))}
    </Card>
  );
}

function MigrationNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
      <div>
        <p className="font-medium">Still being brought over by a migration</p>
        <p className="mt-1 text-muted-foreground">
          Nothing here can be changed until the run finishes, in Settings →
          System → Migrations.
        </p>
      </div>
    </div>
  );
}

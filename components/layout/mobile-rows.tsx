"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import Link from "@/components/ui/link";
import { cn } from "@/lib/utils";
import type { NavItem } from "./nav-config/nav-item";

// The touch-size rows the mobile screens share: cards of 56px rows with an icon tile.
export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "divide-y divide-border overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mx-0.5 mt-5 mb-2 text-[13px] font-medium text-muted-foreground">
      {children}
    </h2>
  );
}

export const ROW =
  "flex min-h-14 w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left";

export function Row({
  href,
  onClick,
  children,
}: {
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return href ? (
    <Link href={href} onClick={onClick} className={ROW}>
      {children}
      <ChevronRight className="size-[18px] shrink-0 text-ring" />
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={ROW}>
      {children}
    </button>
  );
}

export function NavRow({
  item,
  onClick,
}: {
  item: NavItem;
  onClick?: () => void;
}) {
  if (item.disabledReason)
    return (
      <div
        aria-disabled="true"
        className={cn(ROW, "cursor-default text-muted-foreground")}
      >
        <RowIcon icon={item.icon} />
        <Text title={item.label} sub={item.disabledReason} />
      </div>
    );
  return (
    <Row href={item.href} onClick={onClick}>
      <RowIcon icon={item.icon} />
      <Text title={item.label} />
    </Row>
  );
}

export function RowIcon({ icon: Icon }: { icon: NavItem["icon"] }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-foreground">
      <Icon className="size-[17px]" />
    </span>
  );
}

export function Text({ title, sub }: { title: string; sub?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[15px] font-medium">{title}</span>
      {sub && (
        <span className="truncate text-[13px] text-muted-foreground">
          {sub}
        </span>
      )}
    </span>
  );
}

export function PhoneRow({
  icon,
  title,
  sub,
  trail,
  onClick,
}: {
  icon: NavItem["icon"];
  title: string;
  sub?: string;
  trail?: React.ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <RowIcon icon={icon} />
      <Text title={title} sub={sub} />
      {trail}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={ROW}>
      {body}
    </button>
  ) : (
    <div className={cn(ROW, "cursor-default")}>{body}</div>
  );
}

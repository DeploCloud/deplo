"use client";

import * as React from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface RowAction {
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  href?: string;
  external?: string;
  destructive?: boolean;
  disabled?: boolean;
}

/** Below md a row with two or more actions shows one kebab; md+ keeps the inline buttons in `children`. */
export function RowActions({
  title,
  actions,
  children,
}: {
  title: string;
  actions: (RowAction | false | null | undefined)[];
  children?: React.ReactNode;
}) {
  const shown = actions.filter((a): a is RowAction => Boolean(a));
  if (shown.length < 2) return <>{children}</>;
  return (
    <>
      <div className="contents max-md:hidden">{children}</div>
      <div className="ml-auto flex justify-end md:hidden">
        <RowKebab title={title} actions={shown} />
      </div>
    </>
  );
}

export function RowKebab({
  title,
  actions,
}: {
  title: string;
  actions: RowAction[];
}) {
  const safe = actions.filter((a) => !a.destructive);
  const danger = actions.filter((a) => a.destructive);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${title}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="truncate">{title}</DropdownMenuLabel>
        {safe.map((a) => (
          <RowActionItem key={a.label} action={a} />
        ))}
        {safe.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
        {danger.map((a) => (
          <RowActionItem key={a.label} action={a} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RowActionItem({
  action: a,
  className,
}: {
  action: RowAction;
  className?: string;
}) {
  const body = (
    <>
      <a.icon className="size-4" />
      {a.label}
    </>
  );
  const variant = a.destructive ? "destructive" : "default";
  if (a.href && !a.disabled)
    return (
      <DropdownMenuItem asChild variant={variant} className={className}>
        <Link href={a.href}>{body}</Link>
      </DropdownMenuItem>
    );
  if (a.external && !a.disabled)
    return (
      <DropdownMenuItem asChild variant={variant} className={className}>
        <a href={a.external} target="_blank" rel="noopener noreferrer">
          {body}
        </a>
      </DropdownMenuItem>
    );
  return (
    <DropdownMenuItem
      variant={variant}
      disabled={a.disabled}
      onSelect={a.onSelect}
      className={className}
    >
      {body}
    </DropdownMenuItem>
  );
}

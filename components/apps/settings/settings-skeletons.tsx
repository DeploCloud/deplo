import * as React from "react";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { CardFooter, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// A <p> runs at line-height 1.6 (globals.css), so its stand-in must too.
export const P_SM = "text-sm leading-[1.6]";
export const P_XS = "text-xs leading-[1.6]";

/** The SettingsSection header: icon, uppercase title, then a docs link or an info dot. */
export function SectionLabel({
  width,
  trail,
}: {
  width: string;
  trail?: "docs" | "info";
}) {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className="size-4 rounded" />
      <TextLine type="text-xs" className={width} />
      {trail === "docs" && <TextLine type="text-xs" className="w-15" />}
      {trail === "info" && <InfoDot />}
    </div>
  );
}

export function InfoDot() {
  return <Skeleton className="size-3.5 shrink-0 rounded-full" />;
}

export function SwitchSkeleton() {
  return <Skeleton className="h-5 w-9 shrink-0 rounded-full" />;
}

/** A FieldLabel: text-sm leading-none, with its info dot. */
export function FieldLabelSkeleton({
  width,
  info,
}: {
  width: string;
  info?: boolean;
}) {
  return (
    <div className="flex h-3.5 w-fit items-center gap-1.5">
      <Skeleton className={cn("h-3.5", width)} />
      {info && <InfoDot />}
    </div>
  );
}

export function CardHeaderSkeleton({
  title,
  description,
  icon,
  info,
}: {
  title: string;
  description?: string;
  icon?: boolean;
  info?: boolean;
}) {
  return (
    <CardHeader>
      <div className="flex items-center gap-2">
        {icon && <Skeleton className="size-4 rounded" />}
        <TextLine type="text-base leading-none lg:text-lg" className={title} />
        {info && <InfoDot />}
      </div>
      {description && (
        <TextLine type={P_SM} className={cn("max-w-full", description)} />
      )}
    </CardHeader>
  );
}

export function CardFooterSkeleton({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CardFooter className="justify-end gap-2 border-t border-border pt-4">
      {children}
    </CardFooter>
  );
}

/** A bordered toggle row: icon + title over one line of text, control on the right. */
export function FeatureRowSkeleton({
  title,
  description,
  icon = true,
  children,
}: {
  title: string;
  description: string;
  icon?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-56 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            {icon && <Skeleton className="size-4 rounded" />}
            <TextLine type={P_SM} className={title} />
          </div>
          <TextLine type={P_SM} className={cn("max-w-full", description)} />
        </div>
        <div className="flex items-center gap-3">{children}</div>
      </div>
    </div>
  );
}

/** The compact p-3 row of the build panels: title over one text-xs line. */
export function CompactRowTextSkeleton({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center gap-1.5">
        <TextLine type={P_SM} className={title} />
        <InfoDot />
      </div>
      <TextLine type={P_XS} className={cn("max-w-full", description)} />
    </div>
  );
}

export function AccordionRowSkeleton({
  width,
  className,
}: {
  width: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between py-4", className)}>
      <TextLine type="text-sm" className={width} />
      <Skeleton className="size-4 rounded" />
    </div>
  );
}

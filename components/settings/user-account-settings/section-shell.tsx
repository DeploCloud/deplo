"use client";

import * as React from "react";
import { AlertCircle, type LucideIcon } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import type { DocsTopic } from "@/lib/docs";
import { cn } from "@/lib/utils";

// The two shells the real rows and their skeletons BOTH wear, so a padding
// change can't drift the placeholder out of alignment.
export const ROW_SHELL =
  "flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5";

export function sectionShell(tone: "default" | "destructive") {
  return cn(
    "space-y-3 rounded-lg border p-3",
    tone === "destructive"
      ? "border-destructive/40 bg-destructive-wash"
      : "border-border",
  );
}

// Section - a named group of controls, headed by what the admin is editing.
export function Section({
  icon: Icon,
  title,
  info,
  docs,
  tone = "default",
  children,
}: {
  icon: LucideIcon;
  title: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
  tone?: "default" | "destructive";
  children: React.ReactNode;
}) {
  const danger = tone === "destructive";
  return (
    <section className={sectionShell(tone)}>
      <h3
        className={cn(
          "flex w-fit items-center gap-2 text-sm font-semibold",
          danger && "text-destructive",
        )}
      >
        <Icon className="size-4 shrink-0" />
        {title}
        {info != null && (
          <InfoTip content={info} docs={docs} label={`About ${title}`} />
        )}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

// Row - one row: name, its tooltip, and the control.
export function Row({
  title,
  info,
  docs,
  control,
  attached,
}: {
  title: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  control: React.ReactNode;
  // A RowNotice follows - drop the bottom edge so they read as one box.
  attached?: boolean;
}) {
  return (
    <div className={cn(ROW_SHELL, attached && "rounded-b-none")}>
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{title}</span>
        <InfoTip content={info} docs={docs} label={`About ${title}`} />
      </p>
      {/* `flex` on purpose: an inline-flex control in a block box sits on the
          text baseline and drags 5px of descender space in with it. */}
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}

export function ToggleRow({
  title,
  info,
  docs,
  checked,
  disabled,
  onChange,
  attached,
}: {
  title: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  attached?: boolean;
}) {
  return (
    <Row
      title={title}
      info={info}
      docs={docs}
      attached={attached}
      control={
        // The title is a <p>, not a <label>, so the switch carries the name
        // itself, otherwise it announces as a bare "switch, off".
        <Switch
          aria-label={title}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      }
    />
  );
}

// RowNotice - why the row above is locked, glued under it so it reads as part of it.
export function RowNotice({
  tone,
  children,
}: {
  tone: "warning" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-b-lg border border-t-0 px-3 py-2 text-xs",
        tone === "warning"
          ? "border-warning/40 bg-warning-wash-strong text-warning"
          : "border-border bg-surface text-muted-foreground",
      )}
    >
      <AlertCircle className="size-3.5 shrink-0" />
      {children}
    </div>
  );
}

// ActionRow - a row whose control fires straight away, the danger zone's shape.
export function ActionRow({
  title,
  info,
  docs,
  action,
}: {
  title: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  action: React.ReactNode;
}) {
  return <Row title={title} info={info} docs={docs} control={action} />;
}

"use client";

import * as React from "react";
import { AlertCircle, type LucideIcon } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import type { DocsTopic } from "@/lib/docs";
import { cn } from "@/lib/utils";

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
  attached?: boolean;
}) {
  return (
    <div className={cn(ROW_SHELL, attached && "rounded-b-none")}>
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{title}</span>
        <InfoTip content={info} docs={docs} label={`About ${title}`} />
      </p>
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

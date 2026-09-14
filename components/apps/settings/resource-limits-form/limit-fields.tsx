"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { DocsTopic } from "@/lib/docs";
import { cn } from "@/lib/utils";

export function LimitInput({
  id,
  value,
  onChange,
  unit,
  placeholder,
  min,
  step,
  type = "number",
  className,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  min?: number;
  step?: number;
  type?: "number" | "text";
  className?: string;
}) {
  return (
    <div className={cn("relative w-32 shrink-0", className)}>
      <Input
        id={id}
        type={type}
        inputMode={type === "number" ? "decimal" : undefined}
        min={min}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          unit && "pr-14",
        )}
      />
      {unit && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-medium text-muted-foreground">
          {unit}
        </span>
      )}
    </div>
  );
}

// LimitRow is a label on the left, its input on the right: one limit per line.
export function LimitRow({
  id,
  label,
  info,
  docs,
  children,
  note,
}: {
  id: string;
  label: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <FieldLabel
          htmlFor={id}
          info={info}
          docs={docs}
          className="whitespace-nowrap"
        >
          {label}
        </FieldLabel>
        {children}
      </div>
      {note}
    </div>
  );
}

export function LimitGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      className="rounded-lg border border-border px-4 py-3"
    >
      <p className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        <Icon className="size-3.5" />
        {title}
      </p>
      <div className="mt-1 divide-y divide-border">{children}</div>
    </div>
  );
}

// LimitCell is a headline limit: label and input on top, the slider and its readings under.
export function LimitCell({
  id,
  label,
  info,
  docs,
  input,
  children,
}: {
  id: string;
  label: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  input: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FieldLabel
          htmlFor={id}
          info={info}
          docs={docs}
          className="whitespace-nowrap"
        >
          {label}
        </FieldLabel>
        {input}
      </div>
      {children}
    </div>
  );
}

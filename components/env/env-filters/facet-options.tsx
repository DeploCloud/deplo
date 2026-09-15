"use client";

import type * as React from "react";
import { Check } from "lucide-react";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { FacetOption } from "./types";

export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];
}

function groupedOptions(
  options: FacetOption[],
): { group: string | null; options: FacetOption[] }[] {
  const out: { group: string | null; options: FacetOption[] }[] = [];
  for (const opt of options) {
    const group = opt.group ?? null;
    const last = out[out.length - 1];
    if (last && last.group === group) last.options.push(opt);
    else out.push({ group, options: [opt] });
  }
  return out;
}

function FacetGroupHeader({
  group,
  options,
  values,
  onChange,
}: {
  group: string;
  options: FacetOption[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const all = options.every((o) => values.includes(o.value));
  const mine = new Set(options.map((o) => o.value));
  return (
    <div className="flex items-center gap-2 px-2 pt-2 pb-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {group}
      </span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() =>
          onChange(
            all
              ? values.filter((v) => !mine.has(v))
              : [
                  ...values,
                  ...options
                    .filter((o) => !values.includes(o.value))
                    .map((o) => o.value),
                ],
          )
        }
        className="ml-auto cursor-pointer text-xs text-muted-foreground hover:text-foreground"
      >
        {all ? "Unselect all" : "Select all"}
      </button>
    </div>
  );
}

function FacetOptionRow({
  opt,
  checked,
  count,
  onToggle,
  id,
  active,
  onActivate,
}: {
  opt: FacetOption;
  checked: boolean;
  count?: number;
  onToggle: () => void;
  id?: string;
  active?: boolean;
  onActivate?: () => void;
}) {
  return (
    <label
      id={id}
      role={id ? "option" : undefined}
      aria-selected={id ? checked : undefined}
      onMouseEnter={onActivate}
      onMouseDown={id ? (e) => e.preventDefault() : undefined}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        active ? "bg-accent" : "hover:bg-accent",
        count === 0 && !checked && "opacity-50",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      {opt.leading}
      {opt.author && (
        <UserAvatar
          name={opt.author.name}
          username={opt.author.username}
          avatarUrl={opt.author.avatarUrl}
          size="sm"
          className="shrink-0"
        />
      )}
      <span className={cn("truncate", opt.labelClassName)}>{opt.label}</span>
      {opt.hint && (
        <span className="truncate text-xs text-muted-foreground">
          {opt.hint}
        </span>
      )}
      {count != null && (
        <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </label>
  );
}

export function FacetClearRow({
  label,
  on,
  onSelect,
  id,
  active,
  onActivate,
}: {
  label: string;
  on: boolean;
  onSelect: () => void;
  id?: string;
  active?: boolean;
  onActivate?: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role={id ? "option" : undefined}
      aria-selected={id ? !on : undefined}
      onMouseDown={id ? (e) => e.preventDefault() : undefined}
      onMouseEnter={onActivate}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        active ? "bg-accent" : "hover:bg-accent",
        !on && "font-medium",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {!on && <Check className="size-3.5" />}
      </span>
      {label}
    </button>
  );
}

export function FacetOptionList({
  options,
  values,
  counts,
  onChange,
  onToggle,
  optionId,
  activeIndex,
  onActivate,
  empty,
}: {
  options: FacetOption[];
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
  onToggle: (value: string) => void;
  optionId?: (index: number) => string;
  activeIndex?: number;
  onActivate?: (index: number) => void;
  empty?: React.ReactNode;
}) {
  return (
    <div className="max-h-72 space-y-0.5 overflow-y-auto">
      {empty}
      {groupedOptions(options).map((bucket) => (
        <div key={bucket.group ?? ""}>
          {bucket.group && (
            <FacetGroupHeader
              group={bucket.group}
              options={bucket.options}
              values={values}
              onChange={onChange}
            />
          )}
          {bucket.options.map((opt) => {
            const i = options.indexOf(opt) + 1;
            return (
              <FacetOptionRow
                key={opt.value}
                opt={opt}
                checked={values.includes(opt.value)}
                count={counts?.[opt.value]}
                onToggle={() => onToggle(opt.value)}
                id={optionId?.(i)}
                active={activeIndex == null ? undefined : activeIndex === i}
                onActivate={onActivate && (() => onActivate(i))}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

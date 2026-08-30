"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, type DayPickerProps } from "react-day-picker";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/** The shadcn calendar over react-day-picker, painted in the theme's own tokens. */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: DayPickerProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      // `relative`, or the absolutely-positioned nav buttons below anchor
      // themselves to whatever positioned ancestor the popover happens to have.
      className={cn("relative p-3", className)}
      classNames={{
        months: "flex flex-col gap-4 sm:flex-row",
        month: "flex flex-col gap-4",
        month_caption: "flex h-7 items-center justify-center",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "outline", size: "icon-sm" }),
          "absolute top-3 left-3 z-10 opacity-50 hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline", size: "icon-sm" }),
          "absolute top-3 right-3 z-10 opacity-50 hover:opacity-100",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-8 text-xs font-normal text-muted-foreground",
        week: "mt-1 flex w-full",
        // The range's own background is drawn on the CELL, so consecutive days
        // join into one band instead of a row of separate pills.
        day: cn(
          "relative size-8 p-0 text-center text-sm",
          "[&:has(>[data-range-middle])]:bg-accent",
          "[&:has(>[data-range-start])]:rounded-l-md [&:has(>[data-range-start])]:bg-accent",
          "[&:has(>[data-range-end])]:rounded-r-md [&:has(>[data-range-end])]:bg-accent",
        ),
        day_button: cn(
          "size-8 cursor-pointer rounded-md p-0 font-normal",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "aria-selected:bg-primary aria-selected:text-primary-foreground",
          "data-[range-middle]:bg-transparent data-[range-middle]:text-accent-foreground",
        ),
        today: "font-medium text-primary",
        outside: "text-muted-foreground/60",
        disabled: "cursor-not-allowed text-muted-foreground/40",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...rest }) =>
          orientation === "left" ? (
            <ChevronLeft className="size-4" {...rest} />
          ) : (
            <ChevronRight className="size-4" {...rest} />
          ),
      }}
      {...props}
    />
  );
}

"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Minus, Plus, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  LOGS_DISPLAY_DEFAULTS as DEFAULTS,
  LOGS_DISPLAY_KEY,
  LOG_LEADINGS,
  MAX_LOG_SIZE,
  MIN_LOG_SIZE,
  clampLogSize,
  parseLogsDisplay,
  type LogsDisplay,
} from "@/lib/logs-display";
import { cn } from "@/lib/utils";

function read(): LogsDisplay {
  try {
    return parseLogsDisplay(localStorage.getItem(LOGS_DISPLAY_KEY));
  } catch {
    return DEFAULTS;
  }
}

/** The two `:root` tokens every pane reads. Defined in app/globals.css. */
function apply({ size, leading }: LogsDisplay) {
  const root = document.documentElement.style;
  root.setProperty("--log-fs", `${size}px`);
  root.setProperty("--log-lh", String(leading));
}

/**
 * Applies the stored size app-wide. Mounted once in the shell so a pane with no
 * menu of its own - the build log, a destination test - matches the one that set
 * it.
 */
export function LogsDisplayVars() {
  React.useEffect(() => {
    apply(read());
  }, []);
  return null;
}

export function LogsDisplayMenu({ className }: { className?: string }) {
  const [display, setDisplay] = React.useState<LogsDisplay>(DEFAULTS);

  function update(next: LogsDisplay) {
    setDisplay(next);
    apply(next);
    try {
      localStorage.setItem(LOGS_DISPLAY_KEY, JSON.stringify(next));
    } catch {
      // A browser with storage blocked still gets the change for this session.
    }
  }

  const isDefault =
    display.size === DEFAULTS.size && display.leading === DEFAULTS.leading;

  return (
    // Read on open, not on mount: the trigger shows no value, and another tab's
    // change is picked up the next time this one is opened.
    <Popover onOpenChange={(open) => open && setDisplay(read())}>
      <SimpleTooltip content="Display">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-label="Display"
            className={cn("size-9", className)}
          >
            <Type className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </SimpleTooltip>

      <PopoverContent align="end" aria-label="Log display" className="w-56 p-3">
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Text size
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Decrease text size"
                disabled={display.size <= MIN_LOG_SIZE}
                onClick={() =>
                  update({ ...display, size: clampLogSize(display.size - 1) })
                }
              >
                <Minus className="size-3.5" />
              </Button>
              <span
                aria-live="polite"
                className="flex-1 text-center font-mono text-sm tabular-nums"
              >
                {display.size}px
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Increase text size"
                disabled={display.size >= MAX_LOG_SIZE}
                onClick={() =>
                  update({ ...display, size: clampLogSize(display.size + 1) })
                }
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Line spacing
            </span>
            <div className="grid grid-cols-3 gap-1">
              {LOG_LEADINGS.map((l) => (
                <Button
                  key={l.value}
                  size="sm"
                  variant={display.leading === l.value ? "secondary" : "ghost"}
                  aria-pressed={display.leading === l.value}
                  onClick={() => update({ ...display, leading: l.value })}
                >
                  {l.label}
                </Button>
              ))}
            </div>
          </div>

          <Button
            size="sm"
            variant="ghost"
            disabled={isDefault}
            className="text-muted-foreground"
            onClick={() => update(DEFAULTS)}
          >
            Reset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

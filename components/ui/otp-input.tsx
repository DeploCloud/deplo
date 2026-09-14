"use client";

import * as React from "react";

import {
  backspace,
  caretFor,
  isComplete,
  moveCaret,
  pasteDigits,
  typeOrFill,
} from "@/lib/otp-field";
import { cn } from "@/lib/utils";

// OtpInput renders a one-time code as separate boxes; every edit rule lives in lib/otp-field.ts so it is testable without a DOM.
export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  autoFocus = false,
  invalid = false,
  label = "One-time code",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  label?: string;
  className?: string;
}) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  const focusBox = React.useCallback((i: number) => {
    const el = refs.current[i];
    el?.focus();
    el?.select();
  }, []);

  // The value as of the LAST EDIT: `apply` moves focus synchronously, so the newly focused box runs `onFocus` before the re-render and would bounce focus backwards.
  const editedRef = React.useRef(value);
  React.useEffect(() => {
    editedRef.current = value;
  }, [value]);

  // The caller clears a rejected code while the boxes are still disabled, which drops focus on the floor and swallows the next keystroke.
  const filledRef = React.useRef(value.length > 0);
  React.useEffect(() => {
    const wasFilled = filledRef.current;
    filledRef.current = value.length > 0;
    if (!disabled && wasFilled && value.length === 0) focusBox(0);
  }, [value, disabled, focusBox]);

  function apply(edit: { value: string; caret: number }) {
    // Before `focusBox`, which triggers the focus guard below in this same tick.
    editedRef.current = edit.value;
    if (edit.value !== value) onChange(edit.value);
    focusBox(edit.caret);
    if (edit.value !== value && isComplete(edit.value, length))
      onComplete?.(edit.value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === "Backspace") {
      e.preventDefault();
      apply(backspace(value, i, length));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusBox(moveCaret(value, i, -1, length));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusBox(moveCaret(value, i, 1, length));
    }
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex items-center justify-center gap-2", className)}
    >
      {Array.from({ length }, (_, i) => {
        const char = value[i] ?? "";
        return (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            // Not `number`: it brings spinners, accepts "e" and "-", and strips leading zeros.
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            // Only on the first box, where the platform expects to autofill.
            autoComplete={i === 0 ? "one-time-code" : "off"}
            // Not maxLength=1: a controlled box that is already full would swallow the keystroke instead of letting it replace the digit.
            value={char}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            aria-label={`Digit ${i + 1} of ${length}`}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              // Not always one keystroke: an autofilled code arrives here whole, with no paste event.
              apply(typeOrFill(value, i, e.target.value, !char, length));
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            onPaste={(e) => {
              e.preventDefault();
              apply(
                pasteDigits(value, i, e.clipboardData.getData("text"), length),
              );
            }}
            onFocus={() => {
              // Clicking an unreachable box lands on the caret instead of leaving a gap behind.
              const legal = caretFor(editedRef.current, length);
              if (i > legal) focusBox(legal);
              else refs.current[i]?.select();
            }}
            className={cn(
              "h-13 w-11 rounded-lg border bg-background text-center font-mono text-xl tabular-nums transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              invalid
                ? "border-destructive text-destructive"
                : char
                  ? "border-foreground/30 text-foreground"
                  : "border-border text-foreground",
            )}
          />
        );
      })}
    </div>
  );
}

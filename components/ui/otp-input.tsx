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

  const editedRef = React.useRef(value);
  React.useEffect(() => {
    editedRef.current = value;
  }, [value]);

  const filledRef = React.useRef(value.length > 0);
  React.useEffect(() => {
    const wasFilled = filledRef.current;
    filledRef.current = value.length > 0;
    if (!disabled && wasFilled && value.length === 0) focusBox(0);
  }, [value, disabled, focusBox]);

  function apply(edit: { value: string; caret: number }) {
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
            // Not type="number": it brings spinners, accepts "e" and "-", and strips leading zeros.
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            value={char}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            aria-label={`Digit ${i + 1} of ${length}`}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
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

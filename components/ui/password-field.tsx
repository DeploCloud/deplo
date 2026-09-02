"use client";

import * as React from "react";
import { Check, Eye, EyeOff, X } from "lucide-react";

import { FieldLabel } from "@/components/ui/info-tip";
import type { DocsTopic } from "@/lib/docs";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { passwordRuleStatus } from "@/lib/password-policy";
import { cn } from "@/lib/utils";

/** The eye that unmasks a password box. */
function RevealToggle({
  visible,
  onToggle,
  disabled,
  controls,
}: {
  visible: boolean;
  onToggle: () => void;
  disabled?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      aria-controls={controls}
      disabled={disabled}
      className="absolute inset-y-0 end-0 flex h-full w-9 items-center justify-center rounded-e-md text-muted-foreground/80 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      {visible ? (
        <EyeOff className="size-3.5" aria-hidden="true" />
      ) : (
        <Eye className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * A password box with the reveal toggle and nothing else: the current-password
 * and confirm fields, which have no strength of their own to meter.
 */
export function RevealInput({
  className,
  visible: controlled,
  onVisibleChange,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type"> & {
  /** Controlled reveal, for a caller that also unmasks - a Generate button
   *  hands over a password that has to be readable before the dialog closes. */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}) {
  const [own, setOwn] = React.useState(false);
  const visible = controlled ?? own;
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pe-9", className)}
      />
      <RevealToggle
        visible={visible}
        onToggle={() => {
          setOwn(!visible);
          onVisibleChange?.(!visible);
        }}
        disabled={props.disabled}
        controls={props.id}
      />
    </div>
  );
}

/**
 * The field for choosing a password: reveal toggle, strength bar, live checklist.
 * Cosmetic - the gate that counts is `assertPasswordPolicy` server-side.
 */
export function PasswordField({
  id,
  value,
  onChange,
  label = "Password",
  info,
  docs,
  name,
  autoComplete = "new-password",
  placeholder = "Choose a strong password",
  required,
  disabled,
  autoFocus,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  label?: React.ReactNode;
  /** Longer explanation, shown as the label's info tooltip (never as helper text). */
  info?: React.ReactNode;
  docs?: DocsTopic;
  name?: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const [visible, setVisible] = React.useState(false);
  const [hintOpen, setHintOpen] = React.useState(false);

  const rules = passwordRuleStatus(value);
  const score = rules.filter((rule) => rule.met).length;
  const complete = score === rules.length;
  // The meter rides a popover rather than the form: growing a checklist under a
  // field pushes every control below it down on the first keystroke.
  const open = hintOpen && value !== "";

  return (
    <div className={cn("space-y-2", className)}>
      <FieldLabel htmlFor={fieldId} info={info} docs={docs}>
        {label}
      </FieldLabel>
      <Popover open={open} onOpenChange={setHintOpen}>
        <PopoverAnchor asChild>
          {/* Focus is watched on the wrapper, not the input: clicking the reveal
              toggle is still being in the field, and must not close the meter. */}
          <div
            className="relative"
            onFocus={() => setHintOpen(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget))
                setHintOpen(false);
            }}
          >
            <Input
              id={fieldId}
              name={name}
              type={visible ? "text" : "password"}
              className="pe-9"
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                setHintOpen(true);
              }}
              autoComplete={autoComplete}
              placeholder={placeholder}
              required={required}
              disabled={disabled}
              autoFocus={autoFocus}
              aria-describedby={open ? `${fieldId}-strength` : undefined}
            />
            <RevealToggle
              visible={visible}
              onToggle={() => setVisible((v) => !v)}
              disabled={disabled}
              controls={fieldId}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          // Neither edge may move focus: the caret has to stay where the person
          // is typing, and closing must not drag it back out of the next field.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="w-[var(--radix-popover-trigger-width)] min-w-64 space-y-2 p-3"
        >
          <div
            role="progressbar"
            aria-label="Password strength"
            aria-valuemin={0}
            aria-valuemax={rules.length}
            aria-valuenow={score}
            className="flex gap-1"
          >
            {rules.map((rule, i) => (
              <div
                key={rule.text}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors duration-500",
                  i < score ? strengthColor(score) : "bg-border",
                )}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-2">
            <p
              id={`${fieldId}-strength`}
              role="status"
              aria-live="polite"
              className="text-sm font-medium"
            >
              {strengthLabel(score)}
            </p>
            <span className="text-xs text-muted-foreground">
              {score}/{rules.length} met
            </span>
          </div>

          {!complete && (
            <ul aria-label="Password requirements" className="space-y-1">
              {rules.map((rule) => (
                <li key={rule.text} className="flex items-center gap-1.5">
                  {rule.met ? (
                    <Check
                      className="size-3.5 text-success"
                      aria-hidden="true"
                    />
                  ) : (
                    <X
                      className="size-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={cn(
                      "text-xs transition-colors",
                      rule.met ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    {rule.text}
                    <span className="sr-only">
                      {rule.met ? " - met" : " - not met"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Three bands, matching the three labels: a colour that disagrees is noise. */
function strengthColor(score: number): string {
  if (score <= 2) return "bg-destructive";
  if (score <= 4) return "bg-warning";
  return "bg-success";
}

function strengthLabel(score: number): string {
  if (score <= 2) return "Weak password";
  if (score <= 4) return "Almost there";
  return "Strong password";
}

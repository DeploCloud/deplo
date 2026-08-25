"use client";

import * as React from "react";
import { Check, Eye, EyeOff, X } from "lucide-react";

import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { passwordRuleStatus } from "@/lib/password-policy";
import { cn } from "@/lib/utils";

/**
 * The field for choosing a password: reveal toggle, strength bar, live checklist.
 * Cosmetic - the gate that counts is `assertPasswordPolicy` server-side. The
 * meter only appears once there is something to measure.
 */
export function PasswordField({
  id,
  value,
  onChange,
  label = "Password",
  info,
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

  const rules = passwordRuleStatus(value);
  const score = rules.filter((rule) => rule.met).length;
  const complete = score === rules.length;

  return (
    <div className={cn("space-y-2", className)}>
      <FieldLabel htmlFor={fieldId} info={info}>
        {label}
      </FieldLabel>
      <div className="relative">
        <Input
          id={fieldId}
          name={name}
          type={visible ? "text" : "password"}
          className="pe-9"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-describedby={`${fieldId}-strength`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          aria-controls={fieldId}
          disabled={disabled}
          className="absolute inset-y-0 end-0 flex h-full w-9 items-center justify-center rounded-e-md text-muted-foreground/80 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {visible ? (
            <EyeOff className="size-3.5" aria-hidden="true" />
          ) : (
            <Eye className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>

      {value !== "" && (
        <div className="space-y-2 pt-1">
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
            <p id={`${fieldId}-strength`} className="text-sm font-medium">
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
                      className="size-3.5 text-emerald-500"
                      aria-hidden="true"
                    />
                  ) : (
                    <X
                      className="size-3.5 text-muted-foreground/60"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={cn(
                      "text-xs transition-colors",
                      rule.met
                        ? "text-emerald-600 dark:text-emerald-500"
                        : "text-muted-foreground",
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
        </div>
      )}
    </div>
  );
}

function strengthColor(score: number): string {
  if (score <= 1) return "bg-red-500";
  if (score <= 2) return "bg-orange-500";
  if (score <= 3) return "bg-amber-500";
  if (score <= 4) return "bg-green-500";
  return "bg-emerald-500";
}

function strengthLabel(score: number): string {
  if (score <= 2) return "Weak password";
  if (score <= 4) return "Almost there";
  return "Strong password";
}

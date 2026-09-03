"use client";

import * as React from "react";
import { ArrowLeft, Loader2, Pencil, Rocket } from "lucide-react";

import { AvatarPicker } from "@/components/shared/avatar-picker";
import {
  avatarChoiceFromValue,
  avatarPreviewUrl,
  avatarSeedFromName,
} from "@/lib/apps/avatar-shared";
import {
  avatarInitials,
  TeamAvatar,
  UserAvatar,
} from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Field, fieldControl, invalidField } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordField, RevealInput } from "@/components/ui/password-field";
import { passwordMeetsPolicy } from "@/lib/password-policy";
import {
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_MIN,
  validateUsername,
} from "@/lib/username";
import { cn } from "@/lib/utils";

/** Longest name the greeting will show before it truncates. */
const NAME_MAX = 16;

export type AccountDraft = {
  image: string | null;
  name: string;
  handle: string;
  handleEdited: boolean;
  email: string;
  password: string;
  confirm: string;
};

export type TeamDraft = { name: string; image: string | null };

export const EMPTY_ACCOUNT: AccountDraft = {
  image: null,
  name: "",
  handle: "",
  handleEdited: false,
  email: "",
  password: "",
  confirm: "",
};

export const EMPTY_TEAM: TeamDraft = { name: "", image: null };

/** The handle the account gets: derived from the name until it is edited. */
export function draftHandle(d: AccountDraft): string {
  return d.handleEdited ? d.handle : normalizeUsername(d.name);
}

export function accountReady(d: AccountDraft): boolean {
  return (
    d.name.trim() !== "" &&
    d.email.includes("@") &&
    passwordMeetsPolicy(d.password) &&
    d.confirm === d.password &&
    !validateUsername(draftHandle(d))
  );
}

/**
 * The greeting's tail: "." until there is a name, then ", Ada". The width is
 * eased, so typing glides the line open instead of jumping it per keystroke.
 */
function GreetingTail({ name }: { name: string }) {
  const box = React.useRef<HTMLSpanElement>(null);
  const measured = React.useRef<HTMLSpanElement>(null);
  // The first name, hard-capped: the tail cannot wrap, so an unbounded name
  // would push the title past the column and off a phone.
  const first = name.trim().split(/\s+/)[0] ?? "";
  const shown =
    first.length > NAME_MAX ? `${first.slice(0, NAME_MAX)}...` : first;
  const text = shown ? `, ${shown}` : ".";

  React.useLayoutEffect(() => {
    if (box.current && measured.current)
      box.current.style.width = `${measured.current.scrollWidth}px`;
  }, [text]);

  return (
    <span
      ref={box}
      className="inline-block overflow-hidden align-bottom whitespace-pre transition-[width] duration-300 ease-out"
    >
      <span ref={measured} className="inline-block whitespace-pre">
        {text}
      </span>
    </span>
  );
}

/** Label and spinner share one grid cell, so the button never changes width. */
function SubmitFace({
  pending,
  icon: Icon,
  children,
}: {
  pending: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <span className="grid place-items-center">
      <span
        className={cn(
          "col-start-1 row-start-1 flex items-center gap-2",
          pending && "invisible",
        )}
      >
        {Icon && <Icon className="size-4" />}
        {children}
      </span>
      {pending && (
        <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
      )}
    </span>
  );
}

function StepTitle({
  title,
  description,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
}) {
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
        {title}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

/** Who you are: picture, name, handle, email, password. */
export function AccountStep({
  draft,
  onChange,
  description,
  note,
  submitLabel,
  pending = false,
  onSubmit,
  children,
}: {
  draft: AccountDraft;
  onChange: (next: AccountDraft) => void;
  description: React.ReactNode;
  /** The one-line reassurance under the fields. */
  note: React.ReactNode;
  submitLabel: string;
  pending?: boolean;
  onSubmit: () => void;
  /** Between the heading and the fields - the teams a link assigns. */
  children?: React.ReactNode;
}) {
  const handle = draftHandle(draft);
  const pictureChoice = avatarChoiceFromValue(draft.image);
  const bad = handle ? validateUsername(handle) : null;
  // Untouched, the handle is the name's doing, so the name carries the complaint.
  const handleError = draft.handleEdited ? bad : null;
  const nameError = draft.handleEdited ? null : bad;
  const mismatch =
    draft.confirm !== "" && draft.confirm !== draft.password
      ? "Those passwords do not match"
      : null;
  const set = <K extends keyof AccountDraft>(k: K, v: AccountDraft[K]) =>
    onChange({ ...draft, [k]: v });

  return (
    <form
      className="deplo-stagger space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (accountReady(draft) && !pending) onSubmit();
      }}
    >
      <div className="flex justify-center">
        <AvatarPicker
          quiet
          label="Add a profile picture"
          hasImage={Boolean(draft.image)}
          sources={{
            choice: pictureChoice,
            letters: avatarInitials(draft.name, handle),
          }}
          onSave={async (next) => {
            set("image", next);
            return { ok: true };
          }}
          preview={
            <UserAvatar
              name={draft.name}
              username={handle}
              avatarUrl={avatarPreviewUrl(draft.image)}
              size="4xl"
            />
          }
        />
      </div>
      <StepTitle
        title={
          <>
            Welcome to{" "}
            {/* One unit, or a narrow screen wraps the comma onto a line of
                its own. */}
            <span className="whitespace-nowrap">
              Deplo
              <GreetingTail name={draft.name} />
            </span>
          </>
        }
        description={description}
      />
      {children}
      <div className="space-y-2">
        <Label htmlFor="name">Your name</Label>
        <Field error={nameError}>
          <Input
            id="name"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            autoComplete="name"
            placeholder="Ada Lovelace"
            required
            maxLength={80}
            autoFocus
            aria-invalid={Boolean(nameError)}
            className={cn(fieldControl, nameError && invalidField)}
          />
        </Field>
        {draft.handleEdited ? (
          <Field error={handleError}>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-sm text-muted-foreground">
                @
              </span>
              <Input
                id="username"
                value={draft.handle}
                onChange={(e) => set("handle", e.target.value)}
                autoComplete="username"
                minLength={USERNAME_MIN}
                maxLength={USERNAME_MAX}
                aria-label="Handle"
                autoFocus
                aria-invalid={Boolean(handleError)}
                className={cn(
                  "ps-7",
                  fieldControl,
                  handleError && invalidField,
                )}
              />
            </div>
          </Field>
        ) : (
          <button
            type="button"
            onClick={() => onChange({ ...draft, handle, handleEdited: true })}
            className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            @{handle || "your-handle"}
            <Pencil className="size-3" />
          </button>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={draft.email}
          onChange={(e) => set("email", e.target.value)}
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </div>
      <PasswordField
        id="password"
        value={draft.password}
        onChange={(password) => set("password", password)}
        required
      />
      <div className="space-y-2">
        <Label htmlFor="confirm">Confirm password</Label>
        <Field error={mismatch}>
          <RevealInput
            id="confirm"
            value={draft.confirm}
            onChange={(e) => set("confirm", e.target.value)}
            autoComplete="new-password"
            placeholder="Repeat your password"
            required
            aria-invalid={Boolean(mismatch)}
            className={cn(fieldControl, mismatch && invalidField)}
          />
        </Field>
      </div>
      {note}
      <Button
        type="submit"
        className="w-full"
        disabled={pending || !accountReady(draft)}
      >
        <SubmitFace pending={pending}>{submitLabel}</SubmitFace>
      </Button>
    </form>
  );
}

/** Where the work lives: picture and a name. */
export function TeamStep({
  draft,
  onChange,
  title = "Name your team",
  description = "Everything you deploy lives in a team.",
  submitLabel,
  onBack,
  pending = false,
  onSubmit,
}: {
  draft: TeamDraft;
  onChange: (next: TeamDraft) => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  submitLabel: string;
  onBack?: () => void;
  pending?: boolean;
  onSubmit: () => void;
}) {
  const ready = draft.name.trim() !== "";
  return (
    <form
      className="deplo-stagger space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !pending) onSubmit();
      }}
    >
      <div className="flex justify-center">
        <AvatarPicker
          quiet
          label="Add a team picture"
          hasImage={Boolean(draft.image)}
          sources={{
            team: true,
            choice: avatarChoiceFromValue(draft.image),
            letters: avatarSeedFromName(draft.name),
          }}
          onSave={async (image) => {
            onChange({ ...draft, image });
            return { ok: true };
          }}
          preview={
            <TeamAvatar
              name={draft.name || "Team"}
              avatarUrl={draft.image}
              size="4xl"
            />
          }
        />
      </div>
      <StepTitle title={title} description={description} />
      <div className="space-y-2">
        <Label htmlFor="teamName">Team name</Label>
        <Input
          id="teamName"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="Acme"
          required
          maxLength={80}
          autoFocus
        />
      </div>
      <div className="flex items-center gap-2">
        {onBack && (
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            disabled={pending}
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
        )}
        <Button type="submit" className="flex-1" disabled={pending || !ready}>
          <SubmitFace pending={pending} icon={Rocket}>
            {submitLabel}
          </SubmitFace>
        </Button>
      </div>
    </form>
  );
}

/** Where you are in a two-step wizard. */
export function StepDots({
  steps,
  current,
}: {
  steps: { id: string; label: string }[];
  current: string;
}) {
  return (
    <ol className="animate-soft-in mt-8 flex justify-center gap-1.5">
      {steps.map((s) => (
        <li
          key={s.id}
          aria-current={s.id === current ? "step" : undefined}
          className={cn(
            "h-1 rounded-full transition-all duration-300",
            s.id === current ? "w-8 bg-foreground" : "w-4 bg-border",
          )}
        >
          <span className="sr-only">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

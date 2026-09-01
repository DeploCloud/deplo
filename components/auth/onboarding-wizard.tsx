"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  Pencil,
  Rocket,
  ShieldCheck,
} from "lucide-react";

import { DeploLogo } from "@/components/logo";
import { useStepSwap } from "@/components/apps/wizard/wizard-card";
import { AvatarPicker } from "@/components/shared/avatar-picker";
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordField } from "@/components/ui/password-field";
import { gql } from "@/lib/graphql-client";
import { passwordMeetsPolicy } from "@/lib/password-policy";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import { normalizeUsername, validateUsername } from "@/lib/username";
import { cn } from "@/lib/utils";

const COMPLETE_SETUP = /* GraphQL */ `
  mutation CompleteSetup(
    $username: String
    $teamName: String!
    $name: String!
    $email: String!
    $password: String!
    $image: String
    $teamImage: String
  ) {
    completeSetup(
      username: $username
      teamName: $teamName
      name: $name
      email: $email
      password: $password
      image: $image
      teamImage: $teamImage
    ) {
      viewer {
        id
      }
    }
  }
`;

/** The mark holds the screen for this long before it dissolves into step one. */
const INTRO_HOLD_MS = 2200;
const INTRO_OUT_MS = 400;
const INTRO_SEEN = "deplo.onboarding-intro";

type Phase = "boot" | "intro" | "intro-out" | "steps";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function introAlreadyPlayed(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_SEEN) === "1";
  } catch {
    return false;
  }
}

export function OnboardingWizard() {
  const router = useRouter();
  // "boot" renders nothing: deciding on the client is the only way to know
  // whether the intro is owed, and either guess would flash the other screen.
  const [phase, setPhase] = React.useState<Phase>("boot");
  const { step, leaving, go } = useStepSwap<"account" | "team">("account");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const [image, setImage] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [handle, setHandle] = React.useState("");
  const [handleEdited, setHandleEdited] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  const [teamName, setTeamName] = React.useState("");
  const [teamImage, setTeamImage] = React.useState<string | null>(null);

  React.useEffect(() => {
    const play = !introAlreadyPlayed() && !prefersReducedMotion();
    // Stamped up front, not at the end: a reload mid-intro must not replay it.
    if (play) {
      try {
        window.sessionStorage.setItem(INTRO_SEEN, "1");
      } catch {}
    }
    // Every phase is scheduled rather than set inline, the first one included:
    // the first paint has to stay blank until the client knows what is owed.
    const at = (ms: number, next: Phase) =>
      setTimeout(() => setPhase(next), ms);
    const timers = play
      ? [
          at(0, "intro"),
          at(INTRO_HOLD_MS, "intro-out"),
          at(INTRO_HOLD_MS + INTRO_OUT_MS, "steps"),
        ]
      : [at(0, "steps")];
    return () => timers.forEach(clearTimeout);
  }, []);

  const derivedHandle = normalizeUsername(name);
  const shownHandle = handleEdited ? handle : derivedHandle;
  const handleError = handleEdited ? validateUsername(handle) : null;
  const accountReady =
    name.trim() !== "" &&
    email.includes("@") &&
    passwordMeetsPolicy(password) &&
    confirm === password &&
    !handleError;

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await gql(COMPLETE_SETUP, {
          username: handleEdited ? handle : null,
          teamName,
          name,
          email,
          password,
          image,
          teamImage,
        });
        router.push("/?welcome=1");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Setup failed");
      }
    });
  }

  if (phase === "boot") return null;
  if (phase === "intro" || phase === "intro-out")
    return (
      <DeploLogo
        className={cn(
          "text-4xl sm:text-5xl",
          phase === "intro" ? "animate-intro-in" : "animate-intro-out",
        )}
      />
    );

  return (
    <div className="w-full max-w-sm">
      <div
        key={step}
        className={cn(leaving ? "animate-soft-out" : "animate-soft-in")}
      >
        {error && (
          <div className="mb-5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}
        {step === "account" ? (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (accountReady) go("team", "forward");
            }}
          >
            <div className="flex justify-center">
              <AvatarPicker
                quiet
                label="Add a profile picture"
                hasImage={Boolean(image)}
                onSave={async (next) => {
                  setImage(next);
                  return { ok: true };
                }}
                preview={
                  <UserAvatar
                    name={name}
                    username={shownHandle}
                    // The colour the first account is about to be given, so the
                    // mark here is the mark they end up with.
                    avatarColor={AVATAR_COLORS[0]}
                    avatarUrl={image}
                    size="3xl"
                  />
                }
              />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-semibold">Welcome to deplo</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Create the account that runs this instance.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                placeholder="Ada Lovelace"
                required
                maxLength={80}
                autoFocus
              />
              {handleEdited ? (
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-sm text-muted-foreground">
                    @
                  </span>
                  <Input
                    id="username"
                    className="ps-7"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    autoComplete="username"
                    minLength={3}
                    maxLength={32}
                    aria-label="Handle"
                    autoFocus
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setHandle(derivedHandle);
                    setHandleEdited(true);
                  }}
                  className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  @{derivedHandle || "your-handle"}
                  <Pencil className="size-3" />
                </button>
              )}
              {handleError && (
                <p className="text-xs text-destructive">{handleError}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </div>
            <PasswordField
              id="password"
              value={password}
              onChange={setPassword}
              required
            />
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
              {confirm !== "" && confirm !== password && (
                <p className="text-xs text-destructive">
                  Those passwords do not match
                </p>
              )}
            </div>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="mt-px size-3.5 shrink-0" />
              This account controls the whole instance. Turn on two-factor
              authentication once you are set up.
            </p>
            <Button type="submit" className="w-full" disabled={!accountReady}>
              Continue
            </Button>
          </form>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (teamName.trim() && !pending) submit();
            }}
          >
            <div className="flex justify-center">
              <AvatarPicker
                quiet
                label="Add a team picture"
                hasImage={Boolean(teamImage)}
                onSave={async (next) => {
                  setTeamImage(next);
                  return { ok: true };
                }}
                preview={
                  <TeamAvatar
                    name={teamName || "Team"}
                    avatarUrl={teamImage}
                    size="3xl"
                  />
                }
              />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-semibold">Name your team</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Everything you deploy lives in a team.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="teamName">Team name</Label>
              <Input
                id="teamName"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="Acme"
                required
                maxLength={80}
                autoFocus
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => go("account", "back")}
                disabled={pending}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={pending || teamName.trim() === ""}
              >
                <span className="grid place-items-center">
                  <span
                    className={cn(
                      "col-start-1 row-start-1 flex items-center gap-2",
                      pending && "invisible",
                    )}
                  >
                    <Rocket className="size-4" />
                    Create team
                  </span>
                  {pending && (
                    <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                  )}
                </span>
              </Button>
            </div>
          </form>
        )}
      </div>
      <ol className="mt-8 flex justify-center gap-1.5">
        {(["account", "team"] as const).map((s) => (
          <li
            key={s}
            aria-current={s === step ? "step" : undefined}
            className={cn(
              "h-1 w-8 rounded-full transition-colors",
              s === step ? "bg-foreground" : "bg-border",
            )}
          >
            <span className="sr-only">
              {s === "account" ? "Your account" : "Your team"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

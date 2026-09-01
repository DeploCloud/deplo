"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Loader2,
  Pencil,
  Rocket,
  ShieldCheck,
} from "lucide-react";

import { DeploLogo } from "@/components/logo";
import { DiscordIcon, GitHubIcon } from "@/components/shared/brand-icons";
import { useStepSwap } from "@/components/apps/wizard/wizard-card";
import { AvatarPicker } from "@/components/shared/avatar-picker";
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordField } from "@/components/ui/password-field";
import { docsUrl } from "@/lib/docs";
import { gql } from "@/lib/graphql-client";
import { DISCORD_URL, GITHUB_URL } from "@/lib/links";
import { passwordMeetsPolicy } from "@/lib/password-policy";
import { monogramColor } from "@/lib/avatar-colors";
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
const INTRO_OUT_MS = 700;
const INTRO_SEEN = "deplo.onboarding-intro";
/** Longest name the greeting will show before it truncates. */
const NAME_MAX = 16;

type Phase = "boot" | "intro" | "intro-out" | "steps";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Set once the account step is behind you, so a reload before that replays it. */
function introAlreadyPlayed(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_SEEN) === "1";
  } catch {
    return false;
  }
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

export function OnboardingWizard({ version }: { version: string }) {
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

  return (
    <>
      {phase !== "steps" && (
        <div
          className={cn(
            "deplo-aurora pointer-events-none fixed inset-x-0 bottom-0 z-10 h-[55vh] overflow-hidden",
            phase === "intro" ? "animate-aurora-in" : "animate-aurora-out",
          )}
        >
          <span className="deplo-blob" />
          <span className="deplo-blob" />
          <span className="deplo-blob" />
        </div>
      )}
      {phase !== "steps" && (
        <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center">
          <DeploLogo
            className={cn(
              "text-4xl sm:text-5xl",
              phase === "intro" ? "animate-intro-in" : "animate-intro-out",
            )}
          />
        </div>
      )}
      {phase === "steps" && (
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
                  if (!accountReady) return;
                  try {
                    window.sessionStorage.setItem(INTRO_SEEN, "1");
                  } catch {}
                  go("team", "forward");
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
                        // The same derivation the account will be stored with.
                        avatarColor={monogramColor(name)}
                        avatarUrl={image}
                        size="3xl"
                      />
                    }
                  />
                </div>
                <div className="text-center">
                  <h1 className="text-xl font-semibold sm:text-2xl">
                    Welcome to{" "}
                    {/* One unit, or a narrow screen wraps the comma onto a
                      line of its own. */}
                    <span className="whitespace-nowrap">
                      deplo
                      <GreetingTail name={name} />
                    </span>
                  </h1>
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
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!accountReady}
                >
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
                  <h1 className="text-xl font-semibold sm:text-2xl">
                    Name your team
                  </h1>
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
          <ol className="animate-soft-in mt-8 flex justify-center gap-1.5">
            {(["account", "team"] as const).map((s) => (
              <li
                key={s}
                aria-current={s === step ? "step" : undefined}
                className={cn(
                  "h-1 rounded-full transition-all duration-300",
                  s === step ? "w-8 bg-foreground" : "w-4 bg-border",
                )}
              >
                <span className="sr-only">
                  {s === "account" ? "Your account" : "Your team"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {phase === "steps" && (
        <div className="animate-soft-in fixed inset-x-0 bottom-4 flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <span>deplo v{version}</span>
          <span className="h-3 w-px bg-border" />
          {[
            {
              href: docsUrl("docs.home"),
              Icon: BookOpen,
              label: "Documentation",
            },
            { href: GITHUB_URL, Icon: GitHubIcon, label: "GitHub" },
            { href: DISCORD_URL, Icon: DiscordIcon, label: "Discord" },
          ].map(({ href, Icon, label }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              title={label}
              aria-label={label}
              className="transition-colors hover:text-foreground"
            >
              <Icon className="size-4" />
            </a>
          ))}
        </div>
      )}
    </>
  );
}

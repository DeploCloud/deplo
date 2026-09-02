"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ShieldCheck } from "lucide-react";

import {
  AuthChrome,
  LogoIntro,
  useLogoIntro,
} from "@/components/auth/auth-chrome";
import {
  AccountStep,
  EMPTY_ACCOUNT,
  EMPTY_TEAM,
  StepDots,
  TeamStep,
} from "@/components/auth/wizard-steps";
import { useStepSwap } from "@/components/apps/wizard/wizard-card";
import { Collapse } from "@/components/ui/field-error";
import { gql } from "@/lib/graphql-client";
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
    $key: String
  ) {
    completeSetup(
      username: $username
      teamName: $teamName
      name: $name
      email: $email
      password: $password
      image: $image
      teamImage: $teamImage
      key: $key
    ) {
      viewer {
        id
      }
    }
  }
`;

/** Set once the account step is behind you, so a reload before that replays it. */
const INTRO_SEEN = "deplo.onboarding-intro";

const STEPS = [
  { id: "account", label: "Your account" },
  { id: "team", label: "Your team" },
];

export function OnboardingWizard({ setupKey }: { setupKey: string | null }) {
  const router = useRouter();
  const { phase, markSeen } = useLogoIntro(INTRO_SEEN);
  const { step, leaving, go } = useStepSwap<"account" | "team">("account");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [account, setAccount] = React.useState(EMPTY_ACCOUNT);
  const [team, setTeam] = React.useState(EMPTY_TEAM);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await gql(COMPLETE_SETUP, {
          username: account.handleEdited ? account.handle : null,
          teamName: team.name,
          name: account.name,
          email: account.email,
          password: account.password,
          image: account.image,
          teamImage: team.image,
          key: setupKey,
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
      <LogoIntro phase={phase} />
      <AuthChrome hidden={phase !== "steps"} />
      {phase === "steps" && (
        <div className="w-full max-w-sm">
          <div key={step} className={cn(leaving && "animate-soft-out")}>
            <Collapse open={Boolean(error)} className="animate-soft-in">
              <div className="mb-5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </div>
            </Collapse>
            {step === "account" ? (
              <AccountStep
                draft={account}
                onChange={setAccount}
                description="Create the account that runs this instance."
                note={
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="mt-px size-3.5 shrink-0" />
                    This account controls the whole instance. Turn on two-factor
                    authentication once you are set up.
                  </p>
                }
                submitLabel="Continue"
                onSubmit={() => {
                  markSeen();
                  go("team", "forward");
                }}
              />
            ) : (
              <TeamStep
                draft={team}
                onChange={setTeam}
                submitLabel="Create team"
                onBack={() => go("account", "back")}
                pending={pending}
                onSubmit={submit}
              />
            )}
          </div>
          <StepDots steps={STEPS} current={step} />
        </div>
      )}
    </>
  );
}

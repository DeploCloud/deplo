"use client";

import * as React from "react";
import { AlertCircle, ShieldCheck } from "lucide-react";

import {
  AuthChrome,
  LogoIntro,
  useLogoIntro,
} from "@/components/auth/auth-chrome";
import {
  AccountStep,
  EMPTY_TEAM,
  newAccountDraft,
  StepDots,
  TeamStep,
} from "@/components/auth/wizard-steps";
import { useStepSwap } from "@/components/apps/wizard/wizard-card";
import { Collapse } from "@/components/ui/field-error";
import { Button } from "@/components/ui/button";
import { gql, gqlAction, GraphQLRequestError } from "@/lib/graphql-client";
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

const FINISH_SETUP = /* GraphQL */ `
  mutation FinishSetup(
    $username: String
    $teamName: String!
    $name: String!
    $password: String!
    $image: String
    $teamImage: String
  ) {
    finishSetup(
      username: $username
      teamName: $teamName
      name: $name
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

const INTRO_SEEN = "deplo.onboarding-intro";

const STEPS = [
  { id: "account", label: "Your account" },
  { id: "team", label: "Your team" },
];

function errorField(err: unknown): string | null {
  if (!(err instanceof GraphQLRequestError)) return null;
  const field = err.errors[0]?.extensions?.field;
  return typeof field === "string" ? field : null;
}

// `finishEmail` is the account the installer created; the wizard then replaces its temporary password.
export function OnboardingWizard({
  setupKey = null,
  finishEmail,
}: {
  setupKey?: string | null;
  finishEmail?: string;
}) {
  const { phase, markSeen } = useLogoIntro(INTRO_SEEN);
  const { step, leaving, go } = useStepSwap<"account" | "team">("account");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [account, setAccount] = React.useState(() => ({
    ...newAccountDraft(),
    email: finishEmail ?? "",
  }));
  const [team, setTeam] = React.useState(EMPTY_TEAM);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const fields = {
          username: account.handleEdited ? account.handle : null,
          teamName: team.name,
          name: account.name,
          password: account.password,
          image: account.image,
          teamImage: team.image,
        };
        if (finishEmail) await gql(FINISH_SETUP, fields);
        else
          await gql(COMPLETE_SETUP, {
            ...fields,
            email: account.email,
            key: setupKey,
          });
        window.location.assign("/?welcome=1");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Setup failed");
        if (errorField(err) === "password") go("account", "back");
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
              <div className="mb-5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive-wash-strong px-3 py-2 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </div>
            </Collapse>
            {step === "account" ? (
              <AccountStep
                draft={account}
                onChange={setAccount}
                description={
                  finishEmail
                    ? "Your host created this account. Make it yours."
                    : "Create the account that runs this instance."
                }
                emailLocked={Boolean(finishEmail)}
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
                note={
                  <p className="text-xs text-muted-foreground">
                    Deplo sends anonymous usage statistics. Turn this off any
                    time in Settings → Deplo.
                  </p>
                }
                onSubmit={submit}
              />
            )}
          </div>
          <StepDots steps={STEPS} current={step} />
          {finishEmail && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-4 w-full"
              onClick={async () => {
                await gqlAction(`mutation { logout }`, {});
                window.location.assign("/login");
              }}
            >
              Sign out
            </Button>
          )}
        </div>
      )}
    </>
  );
}

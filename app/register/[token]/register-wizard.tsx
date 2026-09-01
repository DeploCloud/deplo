"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, ShieldCheck } from "lucide-react";

import {
  AuthChrome,
  LogoIntro,
  useLogoIntro,
} from "@/components/auth/auth-chrome";
import {
  AccountStep,
  draftHandle,
  EMPTY_ACCOUNT,
  EMPTY_TEAM,
  StepDots,
  TeamStep,
} from "@/components/auth/wizard-steps";
import { useStepSwap } from "@/components/apps/wizard/wizard-card";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { Collapse } from "@/components/ui/field-error";
import { gql } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

const REGISTER = /* GraphQL */ `
  mutation Register(
    $token: String!
    $username: String!
    $name: String!
    $email: String!
    $password: String!
    $teamName: String
    $image: String
    $teamImage: String
  ) {
    registerThroughLink(
      token: $token
      username: $username
      name: $name
      email: $email
      password: $password
      teamName: $teamName
      image: $image
      teamImage: $teamImage
    ) {
      viewer {
        id
      }
    }
  }
`;

const STEPS = [
  { id: "account", label: "Your account" },
  { id: "team", label: "Your team" },
];

export function RegisterWizard({
  token,
  mode,
  teams,
  gravatar = false,
}: {
  token: string;
  /** How this link decides the team: own_team asks for a name; existing_teams
   * pre-assigns and so has no team step. */
  mode: "own_team" | "existing_teams";
  /** For existing_teams: the teams the registrant will join. */
  teams: { name: string; avatarUrl: string | null }[];
  /** Whether the instance offers Gravatar as a picture source. */
  gravatar?: boolean;
}) {
  const router = useRouter();
  const ownTeam = mode === "own_team";
  // No sessionStorage key: a registration link is opened once, so the mark
  // greets every arrival rather than only the first this browser saw.
  const { phase } = useLogoIntro();
  const { step, leaving, go } = useStepSwap<"account" | "team">("account");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [account, setAccount] = React.useState(EMPTY_ACCOUNT);
  const [team, setTeam] = React.useState(EMPTY_TEAM);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await gql(REGISTER, {
          token,
          username: draftHandle(account),
          name: account.name,
          email: account.email,
          password: account.password,
          image: account.image,
          // existing_teams links already carry the team(s) - send no name.
          teamName: ownTeam ? team.name : null,
          teamImage: ownTeam ? team.image : null,
        });
        toast.success("Welcome to Deplo.");
        router.push("/");
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not create the account",
        );
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
                gravatar={gravatar}
                description="Create your account."
                note={
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="mt-px size-3.5 shrink-0" />
                    Turn on two-factor authentication once you are signed in.
                  </p>
                }
                submitLabel={ownTeam ? "Continue" : "Create account"}
                pending={!ownTeam && pending}
                onSubmit={() => (ownTeam ? go("team", "forward") : submit())}
              >
                {!ownTeam && teams.length > 0 && (
                  <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-2 text-sm text-muted-foreground">
                    <span>You will join</span>
                    {/* Each team wears its OWN picture, monogram included -
                        never one stand-in icon for the lot of them. */}
                    {teams.map((t, i) => (
                      <span
                        key={t.name}
                        className="inline-flex items-center gap-1.5 font-medium text-foreground"
                      >
                        <TeamAvatar
                          name={t.name}
                          avatarUrl={t.avatarUrl}
                          size="sm"
                        />
                        {t.name}
                        {i < teams.length - 1 ? "," : "."}
                      </span>
                    ))}
                  </p>
                )}
              </AccountStep>
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
          {ownTeam && <StepDots steps={STEPS} current={step} />}
        </div>
      )}
    </>
  );
}

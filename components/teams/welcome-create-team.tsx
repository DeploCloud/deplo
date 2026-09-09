"use client";

import * as React from "react";
import { toast } from "sonner";

import { EMPTY_TEAM, TeamStep } from "@/components/auth/wizard-steps";
import { DocsLink } from "@/components/ui/docs-link";
import { gqlAction } from "@/lib/graphql-client";

const CREATE_TEAM = /* GraphQL */ `
  mutation CreateTeam($name: String!, $image: String) {
    createTeam(name: $name, image: $image) {
      id
    }
  }
`;

/**
 * The create-team form for a user with ZERO teams. The dashboard needs an active
 * team, so this is the only screen they can reach until they make one. */
export function WelcomeCreateTeam({ userName }: { userName: string }) {
  const [pending, startTransition] = React.useTransition();
  const [team, setTeam] = React.useState(EMPTY_TEAM);

  function create() {
    startTransition(async () => {
      const res = await gqlAction(CREATE_TEAM, {
        name: team.name,
        image: team.image,
      });
      if (res.ok) {
        // Hard, not the router: it cached `/` when this account still had no team.
        window.location.assign("/");
      } else toast.error(res.error);
    });
  }

  return (
    <div className="w-full max-w-sm">
      <TeamStep
        draft={team}
        onChange={setTeam}
        title={`Welcome, ${userName}`}
        description={
          <>
            You are not in a team right now. Create one to keep going.{" "}
            <DocsLink topic="team.overview" />
          </>
        }
        submitLabel="Create team"
        pending={pending}
        onSubmit={create}
      />
    </div>
  );
}

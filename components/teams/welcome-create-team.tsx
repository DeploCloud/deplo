"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The standalone create-team form for a user with ZERO teams (their last team
 * was deleted, or they were removed from it). The dashboard needs an active
 * team, so this is the only screen such a user can reach until they create one
 * — createTeam works for teamless users and activates the new team.
 */
export function WelcomeCreateTeam({ userName }: { userName: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");

  function create() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($name: String!) { createTeam(name: $name) { id } }`,
        { name },
      );
      if (res.ok) {
        router.push("/");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">Welcome, {userName}</CardTitle>
          <CardDescription>
            You&apos;re not a member of any team right now. Create one to keep
            using Deplo, or ask a teammate to invite you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="welcome-team-name">Team name</Label>
            <Input
              id="welcome-team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !pending) create();
              }}
            />
          </div>
          <Button
            className="w-full"
            onClick={create}
            disabled={pending || !name.trim()}
          >
            {pending ? "Creating…" : "Create team"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

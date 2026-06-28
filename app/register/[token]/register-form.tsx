"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { gqlAction } from "@/lib/graphql-client";

const REGISTER = /* GraphQL */ `
  mutation Register(
    $token: String!
    $username: String!
    $name: String!
    $email: String!
    $password: String!
    $teamName: String
  ) {
    registerThroughLink(
      token: $token
      username: $username
      name: $name
      email: $email
      password: $password
      teamName: $teamName
    ) {
      viewer { id }
    }
  }
`;

export function RegisterForm({
  token,
  mode,
  teamNames,
}: {
  token: string;
  /** How this link decides the team: own_team asks for a name; existing_teams
   * pre-assigns and so hides the team-name field. */
  mode: "own_team" | "existing_teams";
  /** For existing_teams: the names of the teams the registrant will join. */
  teamNames: string[];
}) {
  const router = useRouter();
  const ownTeam = mode === "own_team";
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState({
    username: "",
    teamName: "",
    name: "",
    email: "",
    password: "",
  });

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(REGISTER, {
        token,
        username: form.username,
        name: form.name,
        email: form.email,
        password: form.password,
        // existing_teams links already carry the team(s) — send no name.
        teamName: ownTeam ? form.teamName : null,
      });
      if (res.ok) {
        toast.success("Welcome to Deplo");
        router.push("/");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const ready =
    form.username.trim().length >= 3 &&
    (!ownTeam || form.teamName.trim().length > 0) &&
    form.name.trim().length > 0 &&
    form.email.includes("@") &&
    form.password.length >= 8;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>
          {ownTeam
            ? "Pick a username and a team name to get started."
            : "Pick a username to get started — your teams are already set."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reg-username">Username</Label>
            <Input
              id="reg-username"
              value={form.username}
              onChange={set("username")}
              placeholder="ada"
              autoFocus
              minLength={3}
              maxLength={32}
            />
            <p className="text-xs text-muted-foreground">
              Your public handle. Lowercase letters, numbers, - and _.
            </p>
          </div>
          {ownTeam ? (
            <div className="space-y-2">
              <Label htmlFor="reg-team">Team name</Label>
              <Input
                id="reg-team"
                value={form.teamName}
                onChange={set("teamName")}
                placeholder="Acme"
                maxLength={80}
              />
              <p className="text-xs text-muted-foreground">
                Must be unique across the instance.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Teams</Label>
              <div className="rounded-lg border border-border p-3 text-sm">
                You will join{" "}
                <span className="font-medium">{teamNames.join(", ")}</span> when
                you create your account.
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="reg-name">Display name</Label>
            <Input
              id="reg-name"
              value={form.name}
              onChange={set("name")}
              placeholder="Ada Lovelace"
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-email">Email</Label>
            <Input
              id="reg-email"
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-password">Password</Label>
            <Input
              id="reg-password"
              type="password"
              value={form.password}
              onChange={set("password")}
              placeholder="At least 8 characters"
              minLength={8}
            />
          </div>
          <Button
            className="w-full"
            onClick={submit}
            disabled={pending || !ready}
          >
            <Rocket className="size-4" />
            {pending
              ? "Creating account…"
              : ownTeam
                ? "Create account & team"
                : "Create account"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

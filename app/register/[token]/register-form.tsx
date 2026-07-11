"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Rocket, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
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
          {/* Team already assigned (existing_teams link): show it as additional
              info, not an input — the registrant can't change it. */}
          {!ownTeam && teamNames.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground">
                You&apos;ll be added to{" "}
                <span className="font-medium text-foreground">
                  {teamNames.join(", ")}
                </span>{" "}
                when you create your account.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <FieldLabel
              htmlFor="reg-username"
              info="Your public handle. Lowercase letters, numbers, - and _."
            >
              Username
            </FieldLabel>
            <Input
              id="reg-username"
              value={form.username}
              onChange={set("username")}
              placeholder="ada"
              autoFocus
              minLength={3}
              maxLength={32}
            />
          </div>
          {ownTeam && (
            <div className="space-y-2">
              <FieldLabel
                htmlFor="reg-team"
                info="Must be unique across the instance."
              >
                Team name
              </FieldLabel>
              <Input
                id="reg-team"
                value={form.teamName}
                onChange={set("teamName")}
                placeholder="Acme"
                maxLength={80}
              />
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

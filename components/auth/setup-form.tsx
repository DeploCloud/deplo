"use client";

import { useActionState } from "react";
import { AlertCircle, Rocket } from "lucide-react";
import { setupAction, type AuthState } from "@/lib/actions/auth";
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

export function SetupForm() {
  const [state, action, pending] = useActionState<AuthState, FormData>(
    setupAction,
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Welcome to Deplo</CardTitle>
        <CardDescription>
          Create your workspace and admin account. This runs once, on first
          launch.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          {state.error && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              {state.error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="teamName">Workspace name</Label>
            <Input
              id="teamName"
              name="teamName"
              placeholder="Acme"
              required
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              placeholder="ada"
              required
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_\-]+"
            />
            <p className="text-xs text-muted-foreground">
              Your public handle. Lowercase letters, numbers, - and _.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Display name</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              placeholder="Ada Lovelace"
              required
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Admin email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              required
              minLength={8}
            />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            <Rocket className="size-4" />
            {pending ? "Creating workspace…" : "Create workspace"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

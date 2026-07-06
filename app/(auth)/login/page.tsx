"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { gql } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";

const LOGIN = /* GraphQL */ `
  mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      viewer { id }
    }
  }
`;

/** Only allow returning to a safe, in-app path (no open redirect). */
function safeNext(raw: string | null): string {
  return raw && /^\/invite\/[A-Za-z0-9_-]+$/.test(raw) ? raw : "/";
}

export default function LoginPage() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setError(null);
    startTransition(async () => {
      try {
        await gql(LOGIN, { email, password });
        // The session cookie is now set; navigate and refresh the RSC tree.
        router.push(safeNext(next));
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign in failed");
      }
    });
  }

  return (
    // Minimal, softly-contained sign-in: a translucent panel that lifts the form
    // off the layout's dot-grid without the weight of a full card.
    <div className="rounded-2xl border border-border/60 bg-card/60 p-6 shadow-sm backdrop-blur-sm sm:p-8">
      <div className="mb-6 space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Sign in to Deplo</h1>
        <p className="text-sm text-muted-foreground">
          Enter your credentials to continue.
        </p>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
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
            autoComplete="current-password"
            placeholder="••••••••"
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

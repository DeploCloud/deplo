"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { gql } from "@/lib/graphql-client";
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
import { AlertCircle, Loader2 } from "lucide-react";

const LOGIN = /* GraphQL */ `
  mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      viewer { id }
      requiresTwoFactor
    }
  }
`;

const VERIFY_2FA = /* GraphQL */ `
  mutation VerifyTwoFactorLogin($code: String!, $recoveryCode: Boolean) {
    verifyTwoFactorLogin(code: $code, recoveryCode: $recoveryCode) {
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
  // The password step succeeded but the account has a second factor. The
  // challenge itself lives in a short-lived httpOnly cookie Better Auth set, so
  // this flag is all the client needs to hold — no token in component state.
  const [needsCode, setNeedsCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  function done() {
    // The session cookie is now set; navigate and refresh the RSC tree.
    router.push(safeNext(next));
    router.refresh();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setError(null);
    startTransition(async () => {
      try {
        const res = await gql<{ login: { requiresTwoFactor: boolean } }>(LOGIN, {
          email,
          password,
        });
        if (res.login.requiresTwoFactor) {
          setNeedsCode(true);
          return;
        }
        done();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign in failed");
      }
    });
  }

  function onSubmitCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setError(null);
    startTransition(async () => {
      try {
        await gql(VERIFY_2FA, { code, recoveryCode: useRecovery });
        done();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That code is not valid");
      }
    });
  }

  const banner = error && (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="size-4 shrink-0" />
      {error}
    </div>
  );

  if (needsCode)
    return (
      <Card className="bg-transparent! border-transparent!">
        <CardHeader>
          <CardTitle className="text-2xl">Two-factor authentication</CardTitle>
          <CardDescription>
            {useRecovery
              ? "Enter one of the recovery codes you saved when you turned on two-factor authentication."
              : "Enter the 6-digit code from your authenticator app."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmitCode} className="space-y-4">
            {banner}
            <div className="space-y-2">
              <Label htmlFor="code">
                {useRecovery ? "Recovery code" : "Authentication code"}
              </Label>
              <Input
                id="code"
                name="code"
                // A fresh field each time the kind changes, so the browser does
                // not carry a half-typed TOTP into the recovery-code box.
                key={useRecovery ? "recovery" : "totp"}
                autoComplete="one-time-code"
                inputMode={useRecovery ? "text" : "numeric"}
                maxLength={useRecovery ? 24 : 6}
                placeholder={useRecovery ? "xxxxx-xxxxx" : "123456"}
                autoFocus
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Verify
            </Button>
            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setError(null);
                }}
              >
                {useRecovery
                  ? "Use your authenticator app"
                  : "Use a recovery code"}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setNeedsCode(false);
                  setUseRecovery(false);
                  setError(null);
                }}
              >
                Back
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    );

  return (
    <Card className="bg-transparent! border-transparent!">
      <CardHeader>
        <CardTitle className="text-2xl">Welcome back.</CardTitle>
        <CardDescription>
          Welcome back. Enter your credentials to continue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/*
          `method="post"` is load-bearing SECURITY, not a formality. `onSubmit`
          only runs once React has hydrated. A click before that (slow bundle, a
          chunk 404 after a redeploy, JS blocked, the server restarting
          mid-load) falls through to a NATIVE browser submit, and a form with no
          method defaults to GET: every field is appended to the URL as
          `/login?email=x&password=<plaintext>`, which then lands in the address
          bar, browser history, the Referer of every subsequent same-origin
          request, and every reverse-proxy access log in front of us. POST puts
          them in a body nobody logs. Next has no POST handler for this route so
          it just re-renders the page: the failure mode is an unhelpful reload
          instead of a leaked password.
        */}
        <form method="post" onSubmit={onSubmit} className="space-y-4">
          {banner}
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
            {pending && <Loader2 className="size-4 animate-spin" />}
            Sign in
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

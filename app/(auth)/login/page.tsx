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
import { OtpInput } from "@/components/ui/otp-input";
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

/**
 * Only allow returning to a safe, in-app path (no open redirect).
 *
 * A fixed allowlist, not a same-origin check: two destinations legitimately send
 * someone here before they have a session, and everything else goes to the
 * dashboard. `/oauth/consent` is on it because losing that page's query strands
 * a person mid-flow inside a third-party product with no way back except
 * starting over there.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (/^\/invite\/[A-Za-z0-9_-]+$/.test(raw)) return raw;
  if (/^\/oauth\/consent\?/.test(raw)) return raw;
  return "/";
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
  const [code, setCode] = useState("");

  function done() {
    // Signing in mid-OAuth: the provider redirects here with the WHOLE signed
    // authorization query, not a `next` param, so re-run authorize now that a
    // session exists. A full-page assign because that is an API route answering
    // with a 302, which the client router cannot follow.
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("client_id") && sp.has("sig")) {
      // Otherwise the provider sends us straight back here, forever.
      if (sp.get("prompt") === "login") sp.delete("prompt");
      window.location.assign(`/api/auth/oauth2/authorize?${sp}`);
      return;
    }
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

  function submitCode(raw: string) {
    const value = raw.trim();
    if (!value || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        await gql(VERIFY_2FA, { code: value, recoveryCode: useRecovery });
        done();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That code is not valid");
        // A rejected code is never worth resubmitting; an empty field says
        // "try the next one" more clearly than a red field full of stale digits.
        setCode("");
      }
    });
  }

  function switchCodeKind() {
    setUseRecovery((v) => !v);
    setCode("");
    setError(null);
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
              ? "Enter one of the recovery codes you saved when you turned this on."
              : "Enter the 6-digit code from your authenticator app."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            // POST, even though JS always intercepts this: if the page has not
            // hydrated yet (or its bundle failed to load) the browser submits
            // natively, and a GET would put the code in the URL, the history
            // and the proxy access logs. See the sign-in form below.
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              submitCode(code);
            }}
            className="space-y-4"
          >
            {banner}
            {useRecovery ? (
              <div className="space-y-2">
                <Label htmlFor="code">Recovery code</Label>
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  maxLength={24}
                  placeholder="xxxxx-xxxxx"
                  className="font-mono"
                  autoFocus
                  required
                />
              </div>
            ) : (
              <OtpInput
                value={code}
                onChange={setCode}
                // Six digits in, there is nothing left to decide — submitting
                // for them saves a reach for the mouse mid-login.
                onComplete={submitCode}
                disabled={pending}
                invalid={!!error}
                autoFocus
                label="Authentication code"
              />
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={pending || (!useRecovery && code.length !== 6)}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              Verify
            </Button>
            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={switchCodeKind}
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
                  setCode("");
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

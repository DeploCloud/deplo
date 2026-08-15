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
import { AlertCircle, Fingerprint, Loader2 } from "lucide-react";
import {
  getPasskeyAssertion,
  passkeyError,
  passkeysSupported,
} from "@/lib/passkey-client";

const LOGIN = /* GraphQL */ `
  mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      viewer { id }
      requiresTwoFactor
      requiresPasskey
    }
  }
`;

const PASSKEY_CHALLENGE = /* GraphQL */ `
  mutation PasskeyChallenge {
    passkeyChallenge
  }
`;

const VERIFY_PASSKEY = /* GraphQL */ `
  mutation VerifyPasskeyLogin($response: JSON!) {
    verifyPasskeyLogin(response: $response) {
      viewer { id }
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
  // Which half of the sign-in we are on. The password step succeeded but the
  // account has a second factor: an authenticator app ("code") or a passkey
  // ("passkey"). Either challenge lives in a short-lived httpOnly cookie the
  // server set, so this flag is all the client holds - no token in state.
  const [step, setStep] = useState<"password" | "code" | "passkey">("password");
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
        const res = await gql<{
          login: { requiresTwoFactor: boolean; requiresPasskey: boolean };
        }>(LOGIN, { email, password });
        // Mutually exclusive by construction: one means the account has an
        // authenticator app, the other means it does not and its team's policy
        // is resting on its passkey instead.
        if (res.login.requiresTwoFactor) {
          setStep("code");
          return;
        }
        if (res.login.requiresPasskey) {
          setStep("passkey");
          return;
        }
        done();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign in failed");
      }
    });
  }

  /**
   * The whole passkey sign-in: challenge, ceremony, verify.
   *
   * Never fired on mount. A `navigator.credentials.get` with no user gesture
   * behind it is the main source of spurious "cancelled" errors - some browsers
   * refuse it outright, others show a prompt nobody asked for - and one click is
   * cheaper than a login that fails for a reason the person cannot see.
   */
  function signInWithPasskey() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        if (!passkeysSupported())
          throw new Error("This browser can't use passkeys.");
        // The server refuses the challenge outright on an instance that cannot
        // have passkeys (no address, or plain http), with a message saying so -
        // which is why the button is always offered rather than hidden behind a
        // capability this page has no way to know.
        const { passkeyChallenge } = await gql<{ passkeyChallenge: unknown }>(
          PASSKEY_CHALLENGE,
        );
        const response = await getPasskeyAssertion(passkeyChallenge);
        await gql(VERIFY_PASSKEY, { response });
        done();
      } catch (err) {
        setError(passkeyError(err));
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

  const back = (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        setStep("password");
        setUseRecovery(false);
        setCode("");
        setError(null);
      }}
    >
      Back
    </button>
  );

  if (step === "passkey")
    return (
      <Card className="bg-transparent! border-transparent!">
        <CardHeader>
          <CardTitle className="text-2xl">Finish with your passkey</CardTitle>
          <CardDescription>
            This account signs in with a passkey. Your device will ask for your
            fingerprint, face or PIN.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {banner}
          <Button
            className="w-full"
            onClick={signInWithPasskey}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Fingerprint className="size-4" />
            )}
            Use your passkey
          </Button>
          <div className="flex items-center justify-end text-sm">{back}</div>
        </CardContent>
      </Card>
    );

  if (step === "code")
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
              {back}
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
        {/* Secondary, and outside the form so it can never submit it. No email
            field: the challenge is for a discoverable credential, so the browser
            offers the passkeys it holds for this site and the person picks one. */}
        <Button
          variant="outline"
          className="mt-3 w-full"
          onClick={signInWithPasskey}
          disabled={pending}
        >
          <Fingerprint className="size-4" />
          Sign in with a passkey
        </Button>
      </CardContent>
    </Card>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "@/lib/nav";
import { gql } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RevealInput } from "@/components/ui/password-field";
import { Label } from "@/components/ui/label";
import { OtpInput } from "@/components/ui/otp-input";
import { AlertCircle, Fingerprint, Loader2 } from "lucide-react";
import { useStepSwap } from "@/components/apps/wizard/wizard-card";
import { Collapse } from "@/components/ui/field-error";
import {
  getPasskeyAssertion,
  passkeyError,
  passkeysSupported,
} from "@/lib/passkey-client";
import { DocsLink } from "@/components/ui/docs-link";
import { cn } from "@/lib/utils";

const LOGIN = /* GraphQL */ `
  mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      viewer {
        id
      }
      requiresTwoFactor
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
      viewer {
        id
      }
    }
  }
`;

const VERIFY_2FA = /* GraphQL */ `
  mutation VerifyTwoFactorLogin($code: String!, $recoveryCode: Boolean) {
    verifyTwoFactorLogin(code: $code, recoveryCode: $recoveryCode) {
      viewer {
        id
      }
    }
  }
`;

function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (/^\/invite\/[A-Za-z0-9_-]+$/.test(raw)) return raw;
  if (/^\/oauth\/consent\?/.test(raw)) return raw;
  return "/";
}

export default function LoginPage() {
  const next = useSearchParams().get("next");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { step, leaving, go } = useStepSwap<"password" | "code">("password");
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");

  function done() {
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("client_id") && sp.has("sig")) {
      if (sp.get("prompt") === "login") sp.delete("prompt");
      window.location.assign(`/api/auth/oauth2/authorize?${sp}`);
      return;
    }
    window.location.assign(safeNext(next));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setError(null);
    startTransition(async () => {
      try {
        const res = await gql<{ login: { requiresTwoFactor: boolean } }>(
          LOGIN,
          {
            email,
            password,
          },
        );
        if (res.login.requiresTwoFactor) {
          go("code", "forward");
          return;
        }
        done();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign in failed");
      }
    });
  }

  function signInWithPasskey() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        if (!passkeysSupported())
          throw new Error("This browser can't use passkeys.");
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
        setCode("");
      }
    });
  }

  function switchCodeKind() {
    setUseRecovery((v) => !v);
    setCode("");
    setError(null);
  }

  const banner = (
    <Collapse open={Boolean(error)}>
      <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive-wash-strong px-3 py-2 text-sm text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        {error}
      </div>
    </Collapse>
  );

  const title = (heading: string, description: React.ReactNode) => (
    <div className="mb-5 text-center">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
        {heading}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );

  return (
    <div
      key={step}
      className={cn(leaving ? "animate-soft-out" : "deplo-stagger")}
    >
      {step === "code" ? (
        <>
          {title(
            "Two-factor authentication",
            <>
              {useRecovery
                ? "Enter one of the recovery codes you saved when you turned this on."
                : "Enter the 6-digit code from your authenticator app."}{" "}
              <DocsLink topic="team.twoFactor" />
            </>,
          )}
          {banner}
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              submitCode(code);
            }}
            className="space-y-4"
          >
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
                  go("password", "back");
                  setUseRecovery(false);
                  setCode("");
                  setError(null);
                }}
              >
                Back
              </button>
            </div>
          </form>
        </>
      ) : (
        <>
          {title("Welcome back.", "Sign in to continue.")}
          {banner}
          <form method="post" onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email or username</Label>
              <Input
                id="email"
                name="email"
                type="text"
                autoComplete="username"
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <RevealInput
                id="password"
                name="password"
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
          <Button
            variant="outline"
            className="mt-3 w-full"
            onClick={signInWithPasskey}
            disabled={pending}
          >
            <Fingerprint className="size-4" />
            Sign in with a passkey
          </Button>
        </>
      )}
    </div>
  );
}

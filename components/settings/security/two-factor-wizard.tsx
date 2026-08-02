"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { QRCodeSVG } from "qrcode.react";
import { ChevronLeft, ChevronRight, Copy, Download, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/info-tip";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

type StepId = "password" | "scan" | "verify" | "codes";

const STEPS: { id: StepId; label: string }[] = [
  { id: "password", label: "Confirm" },
  { id: "scan", label: "Scan" },
  { id: "verify", label: "Verify" },
  { id: "codes", label: "Recovery codes" },
];

/** The `secret` an authenticator would read out of the otpauth:// URI. */
function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/** Group the base32 secret into readable blocks for hand-typing. */
function spaced(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Turn two-factor authentication on, in four steps: confirm the password, scan
 * the QR, prove the authenticator works, save the recovery codes.
 *
 * The third step is not ceremony. Better Auth does not mark the factor verified
 * until a generated code comes back, so an authenticator that was mis-scanned
 * (or a clock that is badly off) is caught HERE, while the account still logs in
 * with a password alone — rather than at the next sign-in, when it would be a
 * lockout.
 */
export function TwoFactorWizard({
  open,
  onOpenChange,
  /** Rendered instead of the usual close affordances when 2FA is mandatory. */
  mandatory = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mandatory?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<StepId>("password");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [password, setPassword] = React.useState("");
  const [totpUri, setTotpUri] = React.useState("");
  const [backupCodes, setBackupCodes] = React.useState<string[]>([]);
  const [code, setCode] = React.useState("");
  const [saved, setSaved] = React.useState(false);

  const index = STEPS.findIndex((s) => s.id === step);
  const secret = secretOf(totpUri);

  function reset() {
    setStep("password");
    setPassword("");
    setTotpUri("");
    setBackupCodes([]);
    setCode("");
    setSaved(false);
    setError(null);
    setPending(false);
  }

  function close() {
    onOpenChange(false);
    // Deferred so the dialog's close animation does not play over a form that
    // has already been blanked.
    setTimeout(reset, 200);
  }

  /** Step 1: password -> enrol, receiving the URI + the codes in one response. */
  async function enable() {
    setPending(true);
    setError(null);
    const res = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (res.error) {
      setError(res.error.message ?? "That password is not correct");
      return;
    }
    setTotpUri(res.data.totpURI);
    setBackupCodes(res.data.backupCodes);
    setStep("scan");
  }

  /** Step 3: prove the authenticator is in sync before anything depends on it. */
  async function verify() {
    setPending(true);
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: code.trim() });
    setPending(false);
    if (res.error) {
      setError(res.error.message ?? "That code is not valid");
      return;
    }
    setStep("codes");
  }

  function finish() {
    toast.success("Two-factor authentication is on");
    close();
    router.refresh();
  }

  /** Enter runs whatever the current step's primary button does. */
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (step === "password" && password) void enable();
    else if (step === "scan") setStep("verify");
    else if (step === "verify" && code.trim().length === 6) void verify();
    else if (step === "codes" && saved) finish();
  }

  function copyCodes() {
    void navigator.clipboard.writeText(backupCodes.join("\n"));
    toast.success("Recovery codes copied");
  }

  function downloadCodes() {
    const blob = new Blob(
      [
        "deplo recovery codes\n\n",
        "Each code works once. Keep them somewhere you can reach without this account.\n\n",
        backupCodes.join("\n"),
        "\n",
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "deplo-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      {/* Fixed height so the stepper and the footer hold their place instead of
          jumping as the body goes from two fields to a QR code to ten codes. */}
      <DialogContent
        className="h-[min(90vh,42rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-xl"
        // Once the codes are on screen they exist nowhere else, so a stray click
        // outside must not be what loses them.
        hideClose={step === "codes" || mandatory}
        onInteractOutside={(e) => {
          if (step === "codes" || mandatory) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (step === "codes" || mandatory) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Turn on two-factor authentication</DialogTitle>
          <DialogDescription>
            After this, signing in needs your password and a code from your
            phone. Someone who learns your password still cannot get in.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={onSubmit}
          className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden"
        >
          <WizardStepper
            steps={STEPS}
            current={step}
            // Strictly forward: every step depends on the response of the one
            // before it, so there is nothing to go back and edit.
            reachable={(s) => s === step}
            onSelect={setStep}
          />

          <div className="overflow-y-auto focus-safe-scroll">
            {error && (
              <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            {step === "password" && (
              <div className="mx-auto w-full max-w-sm space-y-2">
                <FieldLabel info="Confirming your password makes sure it is you setting this up, not someone who walked up to an unlocked screen.">
                  Current password
                </FieldLabel>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </div>
            )}

            {step === "scan" && (
              <div className="mx-auto w-full max-w-sm space-y-4 text-center">
                <p className="text-sm text-muted-foreground">
                  Scan this with an authenticator app such as 1Password, Bitwarden,
                  Google Authenticator or Aegis.
                </p>
                {/* White plate regardless of theme: a QR inverted by dark mode is
                    unreadable to a lot of scanners. */}
                <div className="mx-auto w-fit rounded-lg bg-white p-4">
                  <QRCodeSVG value={totpUri} size={180} />
                </div>
                <div className="space-y-2 text-left">
                  <FieldLabel info="Type this into your authenticator app instead, if it cannot use the camera.">
                    Or enter this key by hand
                  </FieldLabel>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(secret);
                      toast.success("Setup key copied");
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs break-all hover:bg-muted"
                  >
                    {spaced(secret)}
                    <Copy className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </div>
              </div>
            )}

            {step === "verify" && (
              <div className="mx-auto w-full max-w-sm space-y-2">
                <FieldLabel info="This proves the app is set up correctly and its clock agrees with the server, while your password alone still gets you in.">
                  Code from your authenticator app
                </FieldLabel>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  className="text-center font-mono text-lg tracking-[0.4em]"
                  autoFocus
                />
              </div>
            )}

            {step === "codes" && (
              <div className="mx-auto w-full max-w-sm space-y-4">
                <p className="text-sm text-muted-foreground">
                  Save these somewhere safe. Each one signs you in once if you
                  ever lose your phone. This is the only time they are shown.
                </p>
                <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
                  {backupCodes.map((c) => (
                    <li key={c} className="text-center">
                      {c}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={copyCodes}
                  >
                    <Copy className="size-4" />
                    Copy
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={downloadCodes}
                  >
                    <Download className="size-4" />
                    Download
                  </Button>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={saved}
                    onCheckedChange={(v) => setSaved(v === true)}
                    className="mt-0.5"
                  />
                  I have saved my recovery codes
                </label>
              </div>
            )}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep(STEPS[index - 1].id)}
              // Nothing before "scan" can be revisited (the enrolment already
              // happened) and nothing after "verify" can be undone.
              disabled={index === 0 || step !== "verify" || pending}
              className={cn(step !== "verify" && "invisible")}
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <div className="flex gap-2">
              {step !== "codes" && !mandatory && (
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
              )}
              {step === "password" && (
                <Button type="submit" disabled={pending || !password}>
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Continue
                </Button>
              )}
              {step === "scan" && (
                <Button type="submit">
                  Next
                  <ChevronRight className="size-4" />
                </Button>
              )}
              {step === "verify" && (
                <Button type="submit" disabled={pending || code.trim().length !== 6}>
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Verify
                </Button>
              )}
              {step === "codes" && (
                <Button type="submit" disabled={!saved}>
                  Done
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

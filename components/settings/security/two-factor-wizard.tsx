"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { QRCodeSVG } from "qrcode.react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Lock,
  ScanLine,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RevealInput } from "@/components/ui/password-field";
import { Checkbox } from "@/components/ui/checkbox";
import { OtpInput } from "@/components/ui/otp-input";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { SetupKey } from "./setup-key";
import { deploMarkDataUri } from "@/components/logo";
import { copyText } from "@/lib/clipboard";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

const START_ENROLMENT = /* GraphQL */ `
  mutation StartTwoFactorEnrolment($password: String!) {
    startTwoFactorEnrolment(password: $password) {
      totpUri
      recoveryCodes
    }
  }
`;

const CONFIRM_ENROLMENT = /* GraphQL */ `
  mutation ConfirmTwoFactorEnrolment($code: String!) {
    confirmTwoFactorEnrolment(code: $code)
  }
`;

type StepId = "password" | "scan" | "verify" | "codes";

const STEPS: { id: StepId; label: string }[] = [
  { id: "password", label: "Confirm" },
  { id: "scan", label: "Scan" },
  { id: "verify", label: "Verify" },
  { id: "codes", label: "Recovery" },
];

/** Per-step heading, icon and one line of orientation. */
const COPY: Record<
  StepId,
  {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    blurb: string;
  }
> = {
  password: {
    icon: Lock,
    title: "Confirm it's you",
    blurb:
      "Enter your password so nobody who finds an unlocked screen can add a second factor to your account.",
  },
  scan: {
    icon: ScanLine,
    title: "Scan this with your phone",
    blurb:
      "Open your authenticator app, add an account, and point the camera here.",
  },
  verify: {
    icon: Smartphone,
    title: "Enter the code it shows",
    blurb:
      "This proves the app is set up correctly, while your password alone still gets you in.",
  },
  codes: {
    icon: KeyRound,
    title: "Save your recovery codes",
    blurb:
      "These are how you get back in if you lose your phone. This is the only time they are shown.",
  },
};

/** Apps that work, named so a non-expert has somewhere to start. */
const APPS = ["1Password", "Bitwarden", "Google Authenticator", "Aegis"];

/** The `secret` an authenticator would read out of the otpauth:// URI. */
function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/**
 * Turn two-factor authentication on, in four steps: confirm the password, scan the
 * QR, prove the authenticator works, save the recovery codes.
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
  const { icon: StepIcon, title, blurb } = COPY[step];

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
    const res = await gqlAction<
      { startTwoFactorEnrolment: { totpUri: string; recoveryCodes: string[] } },
      { totpUri: string; recoveryCodes: string[] }
    >(START_ENROLMENT, { password }, (d) => d.startTwoFactorEnrolment);
    setPending(false);
    if (!res.ok || !res.data) {
      setError(res.ok ? "Enrolment failed" : res.error);
      return;
    }
    setTotpUri(res.data.totpUri);
    setBackupCodes(res.data.recoveryCodes);
    setStep("scan");
  }

  /** Step 3: prove the authenticator is in sync before anything depends on it. */
  async function verify(submitted = code) {
    if (submitted.length !== 6 || pending) return;
    setPending(true);
    setError(null);
    const res = await gqlAction(CONFIRM_ENROLMENT, { code: submitted });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      // Clear it: a rejected code is never worth re-submitting, and an empty
      // field is a clearer instruction than a red one full of stale digits.
      setCode("");
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
    else if (step === "verify") void verify();
    else if (step === "codes" && saved) finish();
  }

  async function copyCodes() {
    if (!(await copyText(backupCodes.join("\n")))) return;
    toast.success("Recovery codes copied");
  }

  function downloadCodes() {
    const blob = new Blob(
      [
        "Deplo recovery codes\n\n",
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

  const locked = step === "codes" || mandatory;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      {/* Fixed height so the stepper and the footer hold their place instead of
          jumping as the body goes from one field to a QR code to ten codes. */}
      <DialogContent
        selfManaged
        className="h-[min(92vh,38rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-lg"
        // Once the codes are on screen they exist nowhere else, so a stray click
        // outside must not be what loses them.
        hideClose={locked}
        onInteractOutside={(e) => locked && e.preventDefault()}
        onEscapeKeyDown={(e) => locked && e.preventDefault()}
      >
        {/* pr-8 keeps the last step clear of the absolutely-positioned close X. */}
        <DialogHeader className="space-y-0 pr-8">
          <DialogTitle className="sr-only">
            Turn on two-factor authentication
          </DialogTitle>
          <DialogDescription className="sr-only">
            Set up an authenticator app in four steps.
          </DialogDescription>
          <WizardStepper
            steps={STEPS}
            current={step}
            // Strictly forward: every step depends on the response of the one
            // before it, so there is nothing to go back and edit.
            reachable={(s) => s === step}
            onSelect={setStep}
          />
        </DialogHeader>

        <form
          onSubmit={onSubmit}
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4 overflow-hidden"
        >
          {/**
           * `m-auto` centres the step in the fixed-height body, NOT `justify-center`: a step
           * taller than the row (Scan, Recovery on a short screen) would have its top clipped
           * outside the scrollable area and be unreachable.
           */}
          <div className="focus-safe-scroll flex flex-col overflow-y-auto">
            <div className="m-auto flex w-full max-w-sm shrink-0 flex-col gap-5 py-2">
              {/* One heading block, same shape on every step, so the eye lands
                  in the same place each time the body swaps under it. */}
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                  <StepIcon className="size-5 text-primary" />
                </span>
                <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
                <p className="text-sm text-balance text-muted-foreground">
                  {blurb}
                </p>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-sm text-destructive"
                >
                  {error}
                </p>
              )}

              {step === "password" && (
                <div className="space-y-4">
                  <RevealInput
                    autoComplete="current-password"
                    placeholder="Your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                  />
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs font-medium">
                      You will need an authenticator app on your phone
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {APPS.map((a) => (
                        <span
                          key={a}
                          className="rounded-md bg-background px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-border ring-inset"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Any of them works. If you use a password manager, it
                      probably already does this.
                    </p>
                  </div>
                </div>
              )}

              {step === "scan" && (
                <div className="space-y-4">
                  {/**
                   * Black on white regardless of theme, framed deplo-style.
                   */}
                  <div className="mx-auto w-fit rounded-2xl border border-border bg-white p-4 shadow-sm ring-1 ring-black/5">
                    <QRCodeSVG
                      value={totpUri}
                      size={180}
                      bgColor="#ffffff"
                      fgColor="#0a0a0a"
                      // "H" (30% recovery) is what pays for the excavated middle: the mark covers ~6% of
                      // the area, so the code still reads with room to spare. Any lower level and the
                      // logo breaks it - see lib/two-factor-qr.test.ts.
                      level="H"
                      marginSize={0}
                      imageSettings={{
                        src: deploMarkDataUri(),
                        height: 44,
                        width: 44,
                        // Clear the modules under the badge rather than painting
                        // over them: a scanner that sees half a module there
                        // reads noise, not a gap it can reconstruct.
                        excavate: true,
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">
                      or type it in by hand
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <SetupKey secret={secretOf(totpUri)} />
                </div>
              )}

              {step === "verify" && (
                <div className="space-y-3">
                  <OtpInput
                    value={code}
                    onChange={setCode}
                    // Six digits in means there is nothing left to decide.
                    onComplete={(v) => void verify(v)}
                    disabled={pending}
                    invalid={!!error}
                    autoFocus
                    label="Authentication code"
                  />
                  <p className="text-center text-xs text-muted-foreground">
                    The code changes every 30 seconds. If it is rejected, wait
                    for the next one.
                  </p>
                </div>
              )}

              {step === "codes" && (
                <div className="space-y-4">
                  <div className="flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Save these before you close this window. They cannot be
                      shown again - only replaced.
                    </span>
                  </div>
                  <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                    {backupCodes.map((c, i) => (
                      <li
                        key={c}
                        className="flex items-baseline gap-2 font-mono text-xs"
                      >
                        <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                          {i + 1}
                        </span>
                        <span className="select-all">{c}</span>
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
                  <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
                    <Checkbox
                      checked={saved}
                      onCheckedChange={(v) => setSaved(v === true)}
                      className="mt-0.5"
                    />
                    I have saved my recovery codes somewhere safe
                  </label>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep(STEPS[index - 1].id)}
              // Nothing before "scan" can be revisited (the enrolment already
              // happened) and nothing after "verify" can be undone.
              disabled={step !== "verify" || pending}
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
                  I have scanned it
                  <ChevronRight className="size-4" />
                </Button>
              )}
              {step === "verify" && (
                <Button type="submit" disabled={pending || code.length !== 6}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="size-4" />
                  )}
                  Turn on
                </Button>
              )}
              {step === "codes" && (
                <Button type="submit" disabled={!saved}>
                  <Check className="size-4" />
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

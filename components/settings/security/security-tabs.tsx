"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Fingerprint,
  KeyRound,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react";

import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { PasswordCard } from "./password-card";
import { TwoFactorCard } from "./two-factor-card";
import { PasskeysCard, passkeyBlockedReason } from "./passkeys-card";
import { DevicesPanel } from "./devices-panel";
import { SecurityGraphic, type SecurityLevel } from "./security-graphic";
import { cn } from "@/lib/utils";
import type { PasskeyDTO } from "@/lib/data/passkeys";
import type { UserSessionDTO } from "@/lib/data/sessions";

/**
 * The two halves of the Security page: what proves it is you, and where that
 * proof is currently being held.
 */

const TABS = ["signin", "devices"] as const;
type TabId = (typeof TABS)[number];

export function SecurityTabs({
  twoFactorEnabled,
  requiredBy,
  passkeyStanding,
  passkeys,
  sessions,
  panelUrl,
  rpId,
}: {
  twoFactorEnabled: boolean;
  requiredBy: string | null;
  passkeyStanding: "none" | "idle" | "carrying";
  passkeys: PasskeyDTO[];
  sessions: UserSessionDTO[];
  panelUrl: string | null;
  rpId: string | null;
}) {
  const params = useSearchParams();
  // The hero's one recommendation opens the thing it recommends, so the two
  // dialogs it can reach are owned here rather than inside their own cards.
  const [wizard, setWizard] = React.useState(false);
  const [addPasskey, setAddPasskey] = React.useState(false);

  const requested = params.get("tab");
  const active: TabId = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as TabId)
    : "signin";

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "signin") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    // The native History API, not `router.replace`: the panels are already in
    // the browser and re-running every server read for a query parameter would
    // be a page load to move an underline.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border">
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="signin">
            <KeyRound />
            Sign-in
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="devices">
            <MonitorSmartphone />
            Devices
          </UnderlineTabsTrigger>
        </UnderlineTabsList>
        <SignedInCount
          count={sessions.length}
          onOpen={() => selectTab("devices")}
        />
      </div>

      <TabsContent value="signin">
        {/* Direct grid children, so the two cards of a row share one height
            instead of each ending wherever its own content stops. */}
        <div className="grid gap-4 lg:grid-cols-2">
          <SecurityHero
            twoFactorEnabled={twoFactorEnabled}
            passkeys={passkeys.length}
            passkeysBlocked={passkeyBlockedReason(panelUrl, rpId) !== null}
            onTurnOnTwoFactor={() => setWizard(true)}
            onAddPasskey={() => setAddPasskey(true)}
            onReviewDevices={() => selectTab("devices")}
          />
          <PasswordCard twoFactorEnabled={twoFactorEnabled} />
          <TwoFactorCard
            enabled={twoFactorEnabled}
            requiredBy={requiredBy}
            passkeyStanding={passkeyStanding}
            wizardOpen={wizard}
            onWizardOpenChange={setWizard}
          />
          <PasskeysCard
            passkeys={passkeys}
            panelUrl={panelUrl}
            rpId={rpId}
            addOpen={addPasskey}
            onAddOpenChange={setAddPasskey}
          />
        </div>
      </TabsContent>

      <TabsContent value="devices">
        <DevicesPanel sessions={sessions} />
      </TabsContent>
    </Tabs>
  );
}

/** How many devices hold a session right now, beside the tabs. */
function SignedInCount({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group inline-flex cursor-pointer items-center gap-1.5 pb-3 text-sm text-muted-foreground",
        "underline-offset-4 transition-colors hover:text-foreground hover:underline",
        "focus-visible:text-foreground focus-visible:underline focus-visible:outline-none",
      )}
    >
      <MonitorSmartphone className="size-4" />
      {count} {count === 1 ? "device" : "devices"} signed in
    </button>
  );
}

/** The one thing worth doing next, given what the account already carries. */
function nextStep(args: {
  twoFactorEnabled: boolean;
  passkeys: number;
  passkeysBlocked: boolean;
}) {
  if (!args.twoFactorEnabled)
    return {
      key: "twoFactor" as const,
      icon: ShieldCheck,
      label: "Turn on two-factor authentication",
      hint: "A code from your phone, on top of your password.",
    };
  if (args.passkeys === 0 && !args.passkeysBlocked)
    return {
      key: "passkey" as const,
      icon: Fingerprint,
      label: "Add a passkey",
      hint: "Sign in with your fingerprint, face or device PIN.",
    };
  return {
    key: "devices" as const,
    icon: MonitorSmartphone,
    label: "Review your signed-in devices",
    hint: "Sign out anything you do not recognise.",
  };
}

function SecurityHero({
  twoFactorEnabled,
  passkeys,
  passkeysBlocked,
  onTurnOnTwoFactor,
  onAddPasskey,
  onReviewDevices,
}: {
  twoFactorEnabled: boolean;
  passkeys: number;
  passkeysBlocked: boolean;
  onTurnOnTwoFactor: () => void;
  onAddPasskey: () => void;
  onReviewDevices: () => void;
}) {
  const factors = (twoFactorEnabled ? 1 : 0) + (passkeys > 0 ? 1 : 0);
  const level: SecurityLevel =
    factors === 2 ? "strong" : factors === 1 ? "good" : "weak";
  const headline =
    level === "strong"
      ? "This account is well protected"
      : level === "good"
        ? "This account has a second factor"
        : "Your password is the only thing protecting this account";
  const blurb =
    level === "strong"
      ? "Password, an authenticator app and a passkey."
      : twoFactorEnabled
        ? "Password and an authenticator app."
        : passkeys > 0
          ? "Password and a passkey."
          : "Anyone who learns it can sign in as you.";

  const step = nextStep({ twoFactorEnabled, passkeys, passkeysBlocked });
  const act =
    step.key === "twoFactor"
      ? onTurnOnTwoFactor
      : step.key === "passkey"
        ? onAddPasskey
        : onReviewDevices;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Account protection
          <InfoTip
            content="What this account can prove about you: a password you know, a code from your phone, and a passkey only your device can produce."
            docs="team.security"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {/* The box takes the slack, so the card keeps its neighbour's height;
            the drawing is capped at its own 80px. */}
        <div className="flex min-h-0 flex-1 items-center justify-center py-2">
          <SecurityGraphic level={level} className="max-h-20" />
        </div>
        <div>
          <p className="text-sm font-medium">{headline}</p>
          <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
        </div>
        <button
          type="button"
          onClick={act}
          className="group mt-auto flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-foreground/20 hover:bg-accent"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
            <step.icon className="size-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{step.label}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {step.hint}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </CardContent>
    </Card>
  );
}

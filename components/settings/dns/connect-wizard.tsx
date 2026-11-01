"use client";

import * as React from "react";
import { toast } from "sonner";
import { CircleCheck, Loader2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { StepShell } from "@/components/settings/mcp/connect-wizard/step-shell";
import { cloudflareTokenUrl } from "@/lib/cloudflare/token-url";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import {
  DNS_PROVIDER_META,
  ProviderMark,
  type DnsProviderId,
} from "./provider-mark";
import { TeamAccess, type DnsTeam } from "./team-access";

type StepId = "provider" | "connect" | "teams" | "done";

const STEP_LABEL: Record<StepId, string> = {
  provider: "Provider",
  connect: "Connect",
  teams: "Teams",
  done: "Done",
};
const STEPS: StepId[] = ["provider", "connect", "teams", "done"];

type Checked = { zoneName: string; tunnels: boolean };

export function ConnectWizard({
  teams,
  activeTeamId,
  onCancel,
  onDone,
}: {
  teams: DnsTeam[];
  activeTeamId: string;
  onCancel?: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = React.useState<StepId>("provider");
  const [provider, setProvider] = React.useState<DnsProviderId | null>(null);
  const [zone, setZone] = React.useState("");
  const [token, setToken] = React.useState("");
  const [checked, setChecked] = React.useState<Checked | null>(null);
  const [selected, setSelected] = React.useState<string[]>(() =>
    teams.some((t) => t.id === activeTeamId) ? [activeTeamId] : [],
  );
  const [shared, setShared] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  const valid: Record<StepId, boolean> = {
    provider: provider !== null,
    connect: checked !== null,
    teams: false,
    done: false,
  };
  const reach = (s: StepId) =>
    step === "done"
      ? s === "done"
      : STEPS.slice(0, STEPS.indexOf(s)).every((p) => valid[p]);

  async function check() {
    setPending(true);
    const res = await gqlAction<{ checkDnsProvider: Checked }, Checked>(
      /* GraphQL */ `
        mutation CheckDnsProvider(
          $provider: DnsProviderKind!
          $zone: String!
          $apiToken: String!
        ) {
          checkDnsProvider(
            provider: $provider
            zone: $zone
            apiToken: $apiToken
          ) {
            zoneName
            tunnels
          }
        }
      `,
      { provider, zone: zone.trim(), apiToken: token.trim() },
      (d) => d.checkDnsProvider,
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setChecked(res.data ?? null);
    if (res.data) setZone(res.data.zoneName);
  }

  async function save() {
    setPending(true);
    const res = await gqlAction(
      /* GraphQL */ `
        mutation SaveDnsProvider(
          $provider: DnsProviderKind!
          $zone: String!
          $apiToken: String!
          $teamIds: [String!]!
          $shared: Boolean!
        ) {
          saveDnsProvider(
            provider: $provider
            zone: $zone
            apiToken: $apiToken
            teamIds: $teamIds
            shared: $shared
          ) {
            id
          }
        }
      `,
      {
        provider,
        zone: checked?.zoneName ?? zone.trim(),
        apiToken: token.trim(),
        teamIds: selected,
        shared,
      },
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setStep("done");
  }

  const meta = provider ? DNS_PROVIDER_META[provider] : null;

  return (
    <div className="max-w-xl min-w-0 space-y-6">
      <WizardStepper
        steps={STEPS.map((id) => ({ id, label: STEP_LABEL[id] }))}
        current={step}
        reachable={reach}
        onSelect={setStep}
      />

      {step === "provider" && (
        <StepShell
          title="Where is your domain's DNS?"
          lead="Deplo creates the records there when you add a domain to an app."
          action={
            onCancel ? (
              <Button variant="outline" className="mr-auto" onClick={onCancel}>
                Cancel
              </Button>
            ) : null
          }
        >
          <div
            role="radiogroup"
            aria-label="DNS provider"
            className="grid w-full gap-2 sm:grid-cols-2"
          >
            {(Object.keys(DNS_PROVIDER_META) as DnsProviderId[]).map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={provider === id}
                onClick={() => {
                  setProvider(id);
                  setStep("connect");
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
                  provider === id
                    ? "border-primary ring-1 ring-primary/60"
                    : "border-border hover:border-foreground/20",
                )}
              >
                <ProviderMark provider={id} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {DNS_PROVIDER_META[id].label}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                    {DNS_PROVIDER_META[id].blurb}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </StepShell>
      )}

      {step === "connect" && meta && (
        <StepShell
          title={`Connect your domain on ${meta.label}`}
          lead="Your API token stays yours: nobody else can see it."
          action={
            <>
              <Button
                variant="outline"
                className="mr-auto"
                onClick={() => setStep("provider")}
              >
                Back
              </Button>
              {checked ? (
                <Button onClick={() => setStep("teams")}>Continue</Button>
              ) : (
                <Button
                  onClick={check}
                  disabled={pending || !zone.trim() || !token.trim()}
                >
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Check
                </Button>
              )}
            </>
          }
        >
          <form
            className="w-full space-y-4 text-left"
            onSubmit={(e) => {
              e.preventDefault();
              if (checked) setStep("teams");
              else if (zone.trim() && token.trim() && !pending) void check();
            }}
          >
            <div className="space-y-2">
              <FieldLabel
                htmlFor="dns-zone"
                info="The domain as it is listed in your Cloudflare account. Every name under it gets automatic DNS."
              >
                Domain
              </FieldLabel>
              <Input
                id="dns-zone"
                value={zone}
                onChange={(e) => {
                  setZone(e.target.value);
                  setChecked(null);
                }}
                placeholder="example.com"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <FieldLabel
                htmlFor="dns-token"
                info="Deplo keeps it encrypted, and uses it only to create and delete this domain's records and tunnels."
              >
                Cloudflare API token
              </FieldLabel>
              <Input
                id="dns-token"
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setChecked(null);
                }}
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Needs DNS: Edit, and Cloudflare Tunnel: Edit for tunnels.{" "}
                <a
                  href={cloudflareTokenUrl("Deplo DNS")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Create one
                </a>
              </p>
            </div>
            <button type="submit" hidden />
          </form>
          {checked && (
            <div className="w-full space-y-2 rounded-lg border border-border p-3 text-sm">
              <p className="flex items-center gap-2">
                <CircleCheck className="size-4 shrink-0 text-success" />
                Deplo can create records in{" "}
                <span className="font-mono">{checked.zoneName}</span>
              </p>
              {checked.tunnels ? (
                <p className="flex items-center gap-2">
                  <CircleCheck className="size-4 shrink-0 text-success" />
                  Apps can use a Cloudflare Tunnel
                </p>
              ) : (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <TriangleAlert className="size-4 shrink-0 text-[var(--warning)]" />
                  No Cloudflare Tunnels: the token lacks Cloudflare Tunnel: Edit
                </p>
              )}
            </div>
          )}
        </StepShell>
      )}

      {step === "teams" && (
        <StepShell
          title="Which teams can use it?"
          lead="Domains added in these teams get their DNS created for them."
          action={
            <>
              <Button
                variant="outline"
                className="mr-auto"
                onClick={() => setStep("connect")}
              >
                Back
              </Button>
              <Button
                onClick={save}
                disabled={pending || selected.length === 0}
              >
                {pending && <Loader2 className="size-4 animate-spin" />}
                Save
              </Button>
            </>
          }
        >
          <TeamAccess
            idPrefix="dns-connect"
            teams={teams}
            selected={selected}
            shared={shared}
            onSelected={setSelected}
            onShared={setShared}
          />
        </StepShell>
      )}

      {step === "done" && provider && (
        <StepShell
          mark={<ProviderMark provider={provider} size="lg" />}
          title={`${checked?.zoneName ?? zone} is connected`}
          lead="Add a domain under it to an app, and Deplo creates its DNS record."
          action={<Button onClick={onDone}>Done</Button>}
        >
          {null}
        </StepShell>
      )}
    </div>
  );
}

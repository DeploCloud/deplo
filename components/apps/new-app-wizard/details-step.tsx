"use client";

import * as React from "react";
import { ShieldAlert } from "lucide-react";

import { SOURCE_TABS, sourceLabelFor } from "@/components/apps/source-tabs";
import { ComposeDomainPicker } from "@/components/apps/wizard/compose-domain-picker";
import { SourceMark } from "@/components/apps/wizard/source-tiles";
import { WizardCard } from "@/components/apps/wizard/wizard-card";
import { AdvancedSection } from "@/components/apps/wizard/advanced-section";
import { LogoTile } from "@/components/templates/logo-tile";
import { DocsLink } from "@/components/ui/docs-link";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Bone, Skeleton } from "@/components/ui/skeleton";
import {
  needsHostAccess,
  type LintDiagnostic,
} from "@/lib/deploy/compose-lint/lint";
import type { ComposeRouteCandidate } from "@/lib/deploy/compose-lint/routing";
import type { DeploySource } from "@/lib/types/app";

import { ComposeSummary } from "./compose-summary";
import { detailsDescription, templateTitle } from "./source-hints";
import { templateAlert, WizardAlerts, type WizardAlert } from "./wizard-alerts";
import type { WizardTemplate } from "./types";

export function DetailsStep({
  isTemplate,
  template,
  source,
  meta,
  onBack,
  onNext,
  usesGit,
  onCreateWithoutDeploy,
  nextDisabled,
  pending,
  sourceFields,
  useCompose,
  composeServices,
  composeDiags,
  onOpenCompose,
  routeCandidates,
  extraRouted,
  setExtraRouted,
  nameField,
  noServer,
  hasServers,
  advanced,
}: {
  isTemplate: boolean;
  template?: WizardTemplate;
  source: DeploySource | null;
  meta: React.ReactNode;
  onBack: () => void;
  onNext: () => void;
  usesGit: boolean;
  onCreateWithoutDeploy?: () => void;
  nextDisabled: boolean;
  pending: boolean;
  sourceFields: React.ReactNode;
  useCompose: boolean;
  composeServices: string[];
  composeDiags: LintDiagnostic[];
  onOpenCompose: () => void;
  routeCandidates: ComposeRouteCandidate[];
  extraRouted: string[];
  setExtraRouted: React.Dispatch<React.SetStateAction<string[]>>;
  nameField: React.ReactNode;
  noServer: React.ReactNode;
  hasServers: boolean;
  advanced: React.ReactNode;
}) {
  const alerts: WizardAlert[] = [
    ...(isTemplate ? template!.alerts.map(templateAlert) : []),
    ...(useCompose && needsHostAccess(composeDiags)
      ? [
          {
            type: "warning" as const,
            icon: ShieldAlert,
            content: (
              <>
                This stack reaches the server itself, so it needs the host
                access permission. <DocsLink topic="hostAccess.gated" />
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <WizardCard
      title={
        isTemplate
          ? templateTitle(template!)
          : `Deploy from ${sourceLabelFor(source!)}`
      }
      icon={
        isTemplate ? undefined : (
          <SourceMark tab={SOURCE_TABS.find((t) => t.id === source)!} />
        )
      }
      description={
        isTemplate ? template!.description : detailsDescription(source!)
      }
      meta={meta}
      backLabel={
        isTemplate && !template!.imported ? "Back to templates" : "Back"
      }
      onBack={onBack}
      onNext={onNext}
      nextLabel={usesGit ? "Next" : "Deploy"}
      deploy={!usesGit}
      onCreateWithoutDeploy={onCreateWithoutDeploy}
      nextDisabled={nextDisabled}
      pending={pending}
    >
      {sourceFields}

      {isTemplate && (
        <TemplateIntro
          logo={
            <LogoTile
              src={template!.logo}
              accent={template!.veil}
              size={48}
              logoSize={32}
              className="rounded-lg"
            />
          }
        />
      )}

      {useCompose && (!isTemplate || template!.imported) && (
        <ComposeSummary
          services={composeServices}
          diagnostics={composeDiags}
          onOpen={onOpenCompose}
        />
      )}

      <WizardAlerts alerts={alerts} />

      {useCompose && routeCandidates.length > 1 && (
        <ComposeDomainPicker
          candidates={routeCandidates}
          selected={extraRouted}
          onToggle={(service, on) =>
            setExtraRouted((prev) =>
              on ? [...prev, service] : prev.filter((s) => s !== service),
            )
          }
        />
      )}

      {!usesGit && nameField}
      {!usesGit && noServer}
      {!usesGit && hasServers && advanced}
    </WizardCard>
  );
}

function TemplateIntro({ logo }: { logo: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border p-3">
      {logo}
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        Deplo provisions the stack and exposes it through Traefik.{" "}
        <DocsLink topic="deploy.fromTemplate" />
      </p>
    </div>
  );
}

const noop = () => {};

// A template's step before the page answers: the address names the template, the catalog the rest.
export function TemplateStepSkeleton({
  slug,
  meta,
}: {
  slug: string;
  meta: React.ReactNode;
}) {
  return (
    <WizardCard
      title={<Bone>Template name</Bone>}
      description={
        // A typical catalog length (median to third quartile, 75-87 characters): two lines.
        <Bone>
          What this template runs and what people use it for, in one short line
          of plain text.
        </Bone>
      }
      meta={meta}
      backLabel="Back to templates"
      onBack={noop}
      onNext={noop}
      nextLabel="Deploy"
      deploy
      onCreateWithoutDeploy={noop}
    >
      <TemplateIntro
        logo={<Skeleton className="size-12 shrink-0 rounded-lg" />}
      />
      <AppNameField value={slug} />
      <AdvancedSection summary={<Bone>main-server</Bone>}>
        {null}
      </AdvancedSection>
    </WizardCard>
  );
}

export function AppNameField({
  value,
  onChange,
}: {
  value: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="name"
        info="Shown everywhere in Deplo. It also seeds the app's URL, which is frozen after creation."
      >
        App name
      </FieldLabel>
      <Input
        id="name"
        value={value}
        readOnly={!onChange}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder="my-app"
      />
    </div>
  );
}

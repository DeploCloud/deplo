"use client";

import * as React from "react";
import { ShieldAlert } from "lucide-react";

import { SOURCE_TABS, sourceLabelFor } from "@/components/apps/source-tabs";
import { ComposeDomainPicker } from "@/components/apps/wizard/compose-domain-picker";
import { SourceMark } from "@/components/apps/wizard/source-tiles";
import { WizardCard } from "@/components/apps/wizard/wizard-card";
import { LogoTile } from "@/components/templates/logo-tile";
import { DocsLink } from "@/components/ui/docs-link";
import {
  needsHostAccess,
  type LintDiagnostic,
} from "@/lib/deploy/compose-lint/lint";
import type { ComposeRouteCandidate } from "@/lib/deploy/compose-lint/routing";
import type { DeploySource } from "@/lib/types/app";

import { ComposeSummary } from "./compose-summary";
import { detailsDescription, templateTitle } from "./source-hints";
import { TemplateAlerts } from "./template-alerts";
import type { WizardTemplate } from "./types";

export function DetailsStep({
  isTemplate,
  template,
  source,
  meta,
  onBack,
  onNext,
  usesGit,
  shouldDeploy,
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
  shouldDeploy: boolean;
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
      backLabel={isTemplate ? "Back to templates" : "Back"}
      onBack={onBack}
      onNext={onNext}
      nextLabel={usesGit ? "Next" : shouldDeploy ? "Deploy" : "Create app"}
      deploy={!usesGit && shouldDeploy}
      nextDisabled={nextDisabled}
      pending={pending}
    >
      {sourceFields}

      {isTemplate && (
        <div className="flex items-center gap-4 rounded-lg border border-border p-3">
          <LogoTile
            src={template!.logo}
            accent={template!.veil}
            size={48}
            logoSize={32}
            className="rounded-lg"
          />
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Deplo provisions the stack and exposes it through Traefik.{" "}
            <DocsLink topic="deploy.fromTemplate" />
          </p>
        </div>
      )}

      {isTemplate && <TemplateAlerts alerts={template!.alerts} />}

      {useCompose && !isTemplate && (
        <ComposeSummary
          services={composeServices}
          diagnostics={composeDiags}
          onOpen={onOpenCompose}
        />
      )}

      {useCompose && needsHostAccess(composeDiags) && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-wash-strong px-3.5 py-2.5 text-sm text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0">
            This stack reaches the server itself, so it needs the host access
            permission. <DocsLink topic="hostAccess.gated" />
          </p>
        </div>
      )}

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

"use client";

import * as React from "react";
import { useSearchParams } from "@/lib/nav";
import {
  CircleFadingArrowUp,
  Globe,
  LifeBuoy,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import {
  DeploUpdatesTab,
  type FleetSummary,
} from "@/components/settings/deplo-updates-tab";
import {
  DeploDiagnosticsCard,
  type DiagnosticHost,
} from "@/components/settings/deplo-diagnostics-card";
import { LogsRetentionCard } from "@/components/settings/logs-retention-card";
import { GravatarCard } from "@/components/settings/gravatar-card";
import { CanaryReleasesCard } from "@/components/settings/canary-releases-card";
import { UsageReportCard } from "@/components/settings/usage-report-card";
import {
  InstanceOwnerCard,
  type OwnerCandidate,
} from "@/components/settings/instance-owner-card";
import type { InstanceSettings } from "@/lib/data/instance-settings/settings-store";
import { PanelAddressCard, SOURCE_LABEL } from "./panel-address-card";
import { PanelBackupAddressCard } from "./panel-backup-address-card";
import { PanelHttpCard } from "./panel-http-card";
import { CertificatesCard } from "./certificates-card";
import { SettingGroup } from "./setting-item";

const TABS = ["general", "updates", "advanced"] as const;
type TabId = (typeof TABS)[number];

export function DeploSettingsPanel({
  settings,
  viewerIsOwner,
  viewerTwoFactorEnabled,
  ownerCandidates,
  fleet,
  hosts,
  canary: canarySeed,
}: {
  canary: boolean;
  settings: InstanceSettings;
  viewerIsOwner: boolean;
  viewerTwoFactorEnabled: boolean;
  ownerCandidates: OwnerCandidate[];
  fleet: FleetSummary;
  hosts: DiagnosticHost[];
}) {
  const [canary, setCanary] = React.useState(canarySeed);
  const params = useSearchParams();
  const requested = params.get("tab");
  const active: TabId = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as TabId)
    : "general";

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "general") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab} className="space-y-3">
      <UnderlineTabsList>
        <UnderlineTabsTrigger value="general">
          <Globe className="size-4" />
          General
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="updates">
          <CircleFadingArrowUp className="size-4" />
          Updates
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="advanced">
          <SlidersHorizontal className="size-4" />
          Advanced
        </UnderlineTabsTrigger>
      </UnderlineTabsList>

      <TabsContent value="general">
        <div className="grid gap-4 lg:grid-cols-2">
          <PanelAddressCard settings={settings} />
          <CertificatesCard />
          <div className="lg:col-span-2">
            <InstanceOwnerCard
              ownerName={settings.ownerName}
              viewerIsOwner={viewerIsOwner}
              viewerTwoFactorEnabled={viewerTwoFactorEnabled}
              candidates={ownerCandidates}
            />
          </div>
        </div>
      </TabsContent>

      <TabsContent
        value="updates"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        <DeploUpdatesTab
          active={active === "updates"}
          version={settings.version}
          canary={canary}
          fleet={fleet}
        />
      </TabsContent>
      <TabsContent value="advanced" className="space-y-8">
        <SettingGroup icon={SlidersHorizontal} title="Instance">
          <LogsRetentionCard logMaxDays={settings.logMaxDays} />
          <GravatarCard enabled={settings.gravatarEnabled} />
          <CanaryReleasesCard enabled={canary} onChange={setCanary} />
        </SettingGroup>
        <SettingGroup icon={Globe} title="Panel access">
          <PanelBackupAddressCard settings={settings} />
          <PanelHttpCard />
        </SettingGroup>
        <SettingGroup icon={ShieldCheck} title="Privacy">
          <UsageReportCard
            enabled={settings.usageReportsEnabled}
            forcedOff={settings.usageReportsForcedOff}
            lastSentAt={settings.usageReportLastSentAt}
          />
        </SettingGroup>
        <SettingGroup icon={LifeBuoy} title="Support">
          <DeploDiagnosticsCard
            version={settings.version}
            panelUrl={settings.panelUrl}
            panelUrlSource={SOURCE_LABEL[settings.panelUrlSource]}
            deploHostName={settings.deploHostName}
            expectedAgentVersion={fleet.expected}
            hosts={hosts}
          />
        </SettingGroup>
      </TabsContent>
    </Tabs>
  );
}

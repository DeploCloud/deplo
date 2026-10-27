"use client";

import * as React from "react";
import { Download, ExternalLink, Info, Scale } from "lucide-react";

import { SettingsSection } from "@/components/apps/settings/settings-shared";
import {
  LicensesPanel,
  type Notice,
} from "@/components/settings/licenses-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { GITHUB_URL } from "@/lib/links";
import { cn } from "@/lib/utils";
import { DEPLO_COMMIT, DEPLO_VERSION } from "@/lib/version";

export function DeploAboutTab({ notices }: { notices: Notice[] }) {
  const ref = DEPLO_COMMIT || "main";
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsSection icon={Info} title="This version" />
        <Card>
          <CardContent className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
            <Row label="Version">
              <span className="font-mono">v{DEPLO_VERSION}</span>
            </Row>
            <Row label="Commit">
              {DEPLO_COMMIT ? (
                <Out
                  href={`${GITHUB_URL}/commit/${DEPLO_COMMIT}`}
                  label={DEPLO_COMMIT.slice(0, 7)}
                  mono
                />
              ) : (
                <span className="text-muted-foreground">Unknown</span>
              )}
            </Row>
            <Row label="License">
              <Out
                href={`${GITHUB_URL}/blob/${ref}/LICENSE`}
                label="AGPL-3.0"
              />
            </Row>
            <Row label="Source code">
              <Out href={`${GITHUB_URL}/tree/${ref}`} label="GitHub" />
            </Row>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <SettingsSection icon={Scale} title="Open source licenses" />
            <Badge variant="secondary" className="tabular-nums">
              {notices.length}
            </Badge>
          </div>
          {notices.length > 0 && (
            <Button asChild size="sm" variant="outline">
              <a href="/third-party-notices.txt" download>
                <Download className="size-4" />
                Download
              </a>
            </Button>
          )}
        </div>
        <LicensesPanel notices={notices} />
      </section>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <dl>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </dl>
  );
}

function Out({
  href,
  label,
  mono,
}: {
  href: string;
  label: string;
  mono?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 hover:text-muted-foreground",
        mono && "font-mono",
      )}
    >
      {label}
      <ExternalLink className="size-3.5 text-muted-foreground" />
    </a>
  );
}

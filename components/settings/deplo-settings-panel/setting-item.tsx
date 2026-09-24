import * as React from "react";

import { Card } from "@/components/ui/card";
import { FieldLabel } from "@/components/ui/info-tip";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import type { DocsTopic } from "@/lib/docs";

export function SettingGroup({
  icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <SettingsSection icon={icon} title={title} />
      <Card className="divide-y divide-border">{children}</Card>
    </section>
  );
}

export function SettingItem({
  icon: Icon,
  title,
  badge,
  description,
  info,
  docs,
  htmlFor,
  control,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  badge?: React.ReactNode;
  description?: React.ReactNode;
  info?: React.ReactNode;
  docs?: DocsTopic;
  htmlFor?: string;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-3 p-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <FieldLabel htmlFor={htmlFor} info={info} docs={docs}>
              {title}
            </FieldLabel>
            {badge}
          </div>
          {description && (
            <div className="text-sm text-muted-foreground">{description}</div>
          )}
        </div>
        {control && (
          <div className="flex shrink-0 items-center gap-2">{control}</div>
        )}
      </div>
      {children}
    </div>
  );
}

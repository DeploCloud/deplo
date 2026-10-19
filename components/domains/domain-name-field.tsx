"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { regenerateAutoDomain } from "@/lib/auto-domain-suggestion";

export function DomainNameField({
  id,
  value,
  onChange,
  suggestedDomain,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (name: string) => void;
  suggestedDomain?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel
          htmlFor={id}
          info={
            suggestedDomain
              ? "Generate a free .deplo.site address without changing the other settings. Save to apply it."
              : "The hostname to route to this app, e.g. app.example.com. Point its DNS at the server to verify."
          }
          docs="domains.noDomainYet"
        >
          Domain
        </FieldLabel>
        {suggestedDomain && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            disabled={disabled}
            onClick={() =>
              onChange(regenerateAutoDomain(suggestedDomain, value))
            }
          >
            <Sparkles className="size-3.5" />
            Generate
          </Button>
        )}
      </div>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="app.example.com"
        className="font-mono text-sm"
        disabled={disabled}
      />
    </div>
  );
}

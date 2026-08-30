"use client";

import { useRouter } from "next/navigation";
import {
  Plus,
  FileText,
  KeyRound,
  ShieldAlert,
  Eye,
  Rocket,
  Bot,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { TOKEN_PRESETS, type TokenPresetId } from "@/lib/token-presets";

/** Marks for the shipped templates. Data stays in `lib/token-presets.ts`. */
export const TOKEN_PRESET_ICON: Record<TokenPresetId, LucideIcon> = {
  readonly: Eye,
  ci: Rocket,
  mcp: Bot,
  automation: Workflow,
  root: ShieldAlert,
};

/** The mark for a token whose permissions match no template. */
export const CUSTOM_TOKEN_ICON = KeyRound;

/**
 * "New token" is a menu, not a button: a token's permission set is mandatory, and
 * forty checkboxes is not a first decision anyone should have to make.
 */
export function NewTokenMenu() {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          New token
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          className="cursor-pointer"
          onSelect={() => router.push("/settings/tokens/new")}
        >
          <FileText className="size-4" />
          <span className="flex flex-col">
            <span>Start from scratch</span>
            <span className="text-xs text-muted-foreground">
              View access only, then pick what to add
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Start from a template</DropdownMenuLabel>
        {TOKEN_PRESETS.map((p) => {
          const Icon = TOKEN_PRESET_ICON[p.id];
          return (
            <DropdownMenuItem
              key={p.id}
              className="cursor-pointer"
              onSelect={() =>
                router.push(`/settings/tokens/new?preset=${p.id}`)
              }
            >
              <Icon className="size-4 self-start" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {p.description}
                </span>
              </span>
              <span className="shrink-0 self-start text-xs text-muted-foreground tabular-nums">
                {p.capabilities.filter((c) => c !== "view").length}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { ChevronDown, Database, Plus, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type AddKind = "shared" | "database";

const MORE = [
  {
    kind: "shared",
    icon: Share2,
    label: "Shared",
    hint: "Link a variable your team already shares",
  },
  {
    kind: "database",
    icon: Database,
    label: "Database",
    hint: "Connect one of your databases to this app",
  },
] as const;

// The left half adds a row in the list; the chevron opens what is picked, not typed.
export function EnvAddButton({
  onAdd,
  onMore,
  disabled,
  size = "default",
}: {
  onAdd: () => void;
  onMore: (kind: AddKind) => void;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  return (
    <div className="flex shrink-0 gap-px">
      <Button
        size={size}
        disabled={disabled}
        onClick={onAdd}
        className="rounded-r-none"
      >
        <Plus className="size-4" />
        Add
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size={size}
            disabled={disabled}
            aria-label="More ways to add"
            className="rounded-l-none px-2.5 data-[state=open]:bg-primary-hover"
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {MORE.map(({ kind, icon: Icon, label, hint }) => (
            <DropdownMenuItem
              key={kind}
              onSelect={() => onMore(kind)}
              className="items-start gap-3 py-2"
            >
              <Icon className="mt-0.5 text-muted-foreground" />
              <div>
                <p className="text-sm">{label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

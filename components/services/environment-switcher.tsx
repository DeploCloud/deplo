"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The project drill-in's ENVIRONMENT dropdown (ADR-0009): each environment of a
 * project holds its own services, so picking one here switches which services
 * (and which environment-scoped variables) the Overview shows. The selection
 * rides the URL (`/?project=<id>&env=<envId>`), so it survives refreshes and is
 * shareable.
 */
export function EnvironmentSwitcher({
  projectId,
  view,
  environments,
  selectedId,
}: {
  projectId: string;
  view: "grid" | "list";
  environments: { id: string; name: string; isDefault: boolean }[];
  selectedId: string;
}) {
  const router = useRouter();
  const selected = environments.find((e) => e.id === selectedId);

  function select(envId: string) {
    const params = new URLSearchParams();
    params.set("project", projectId);
    params.set("env", envId);
    if (view === "list") params.set("view", "list");
    router.replace(`/?${params.toString()}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Boxes className="size-4 text-muted-foreground" />
          {selected?.name ?? "Environment"}
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {environments.map((e) => (
          <DropdownMenuItem
            key={e.id}
            className="cursor-pointer"
            onSelect={() => select(e.id)}
          >
            <Check
              className={cn(
                "size-4",
                e.id === selectedId ? "opacity-100" : "opacity-0",
              )}
            />
            <span className="flex-1 truncate">{e.name}</span>
            {e.isDefault && (
              <span className="text-xs text-muted-foreground">default</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { Archive, Hammer, ServerCog } from "lucide-react";

import { BetaChip } from "@/components/shared/beta-chip";
import { AccessOption } from "@/components/servers/server-team-access";

export type ServerRole = "everything" | "build" | "storage";

export const SERVER_ROLES: {
  id: ServerRole;
  icon: React.ElementType;
  title: string;
  description: string;
  hue: number;
  iconClassName: string;
  beta?: boolean;
}[] = [
  {
    id: "everything",
    icon: ServerCog,
    title: "Everything",
    description: "Runs apps and builds them",
    hue: 258,
    iconClassName: "text-info",
  },
  {
    id: "build",
    icon: Hammer,
    title: "Build",
    description: "Builds for other servers",
    hue: 73,
    iconClassName: "text-warning",
    beta: true,
  },
  {
    id: "storage",
    icon: Archive,
    title: "Backups",
    description: "Holds backup files",
    hue: 293,
    iconClassName: "text-violet",
  },
];

export function ServerRoleOptions({
  value,
  onChange,
  disabled,
}: {
  value: ServerRole;
  onChange: (role: ServerRole) => void;
  disabled?: (role: ServerRole) => boolean;
}) {
  return (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
      {SERVER_ROLES.map((role) => (
        <AccessOption
          key={role.id}
          icon={role.icon}
          title={role.title}
          description={role.description}
          accent={{ hue: role.hue, iconClassName: role.iconClassName }}
          selected={value === role.id}
          disabled={disabled?.(role.id)}
          onSelect={() => onChange(role.id)}
          badge={role.beta ? <BetaChip /> : undefined}
        />
      ))}
    </div>
  );
}

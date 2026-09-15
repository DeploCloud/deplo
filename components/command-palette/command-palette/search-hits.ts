import * as React from "react";
import {
  Braces,
  Clock,
  FolderTree,
  Globe,
  Layers,
  LayoutTemplate,
  Server,
  ShieldCheck,
} from "lucide-react";

import {
  folderHref,
  placementHref,
  projectHref,
  templateHref,
} from "@/lib/overview-links";
import type { DatabaseType } from "@/lib/types/database";

export interface HitTeam {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface SearchData {
  search: {
    apps: {
      id: string;
      name: string;
      slug: string;
      logo: string | null;
      team: HitTeam;
    }[];
    databases: {
      id: string;
      name: string;
      logo: string | null;
      type: DatabaseType;
      team: HitTeam;
    }[];
    servers: { id: string; name: string; host: string }[];
    projects: { id: string; name: string; team: HitTeam }[];
    environments: {
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      team: HitTeam;
    }[];
    folders: { id: string; name: string; team: HitTeam }[];
    domains: {
      id: string;
      name: string;
      appSlug: string;
      appName: string;
      team: HitTeam;
    }[];
    members: {
      userId: string;
      name: string;
      username: string;
      avatarUrl: string | null;
      avatarColor: string;
      team: HitTeam;
    }[];
    roles: { id: string; name: string; memberCount: number; team: HitTeam }[];
    cronJobs: {
      id: string;
      name: string;
      targetKind: string;
      targetRef: string;
      targetName: string;
      team: HitTeam;
    }[];
    templates: { slug: string; name: string; logo: string | null }[];
  };
}

export interface Hit {
  id: string;
  label: string;
  hint?: string;
  group: string;
  href: string;
  team: HitTeam | null;
  logo?:
    | { kind: "app"; logo: string | null }
    | { kind: "database"; logo: string | null; type: DatabaseType }
    | { kind: "person"; name: string; avatarUrl: string | null }
    | { kind: "team"; name: string; avatarUrl: string | null };
  icon?: React.ComponentType<{ className?: string }>;
}

export function toHits(data: SearchData): Hit[] {
  const s = data.search;
  return [
    ...s.apps.map((a) => ({
      id: `app:${a.id}`,
      label: a.name,
      hint: a.slug,
      group: "Apps",
      href: `/apps/${a.slug}`,
      team: a.team,
      logo: { kind: "app" as const, logo: a.logo },
    })),
    ...s.databases.map((d) => ({
      id: `db:${d.id}`,
      label: d.name,
      hint: d.type,
      group: "Databases",
      href: `/storage/databases/${d.id}`,
      team: d.team,
      logo: { kind: "database" as const, logo: d.logo, type: d.type },
    })),
    ...s.servers.map((v) => ({
      id: `server:${v.id}`,
      label: v.name,
      hint: v.host,
      group: "Servers",
      href: `/settings/servers/${v.id}`,
      team: null,
      icon: Server,
    })),
    ...s.projects.map((p) => ({
      id: `project:${p.id}`,
      label: p.name,
      group: "Projects",
      href: projectHref(p.id),
      team: p.team,
      icon: Layers,
    })),
    ...s.environments.map((e) => ({
      id: `env:${e.id}`,
      label: e.name,
      hint: e.projectName,
      group: "Environments",
      href: placementHref({ projectId: e.projectId, environmentId: e.id }),
      team: e.team,
      icon: Braces,
    })),
    ...s.folders.map((f) => ({
      id: `folder:${f.id}`,
      label: f.name,
      group: "Folders",
      href: folderHref(f.id),
      team: f.team,
      icon: FolderTree,
    })),
    ...s.domains.map((d) => ({
      id: `domain:${d.id}`,
      label: d.name,
      hint: d.appName,
      group: "Domains",
      href: `/apps/${d.appSlug}/domains`,
      team: d.team,
      icon: Globe,
    })),
    ...s.members.map((m) => ({
      id: `member:${m.team.id}:${m.userId}`,
      label: m.name,
      hint: m.username,
      group: "Members",
      href: `/settings/members/${m.userId}`,
      team: m.team,
      logo: {
        kind: "person" as const,
        name: m.name,
        avatarUrl: m.avatarUrl,
      },
    })),
    ...s.roles.map((r) => ({
      id: `role:${r.id}`,
      label: r.name,
      hint: `${r.memberCount} ${r.memberCount === 1 ? "member" : "members"}`,
      group: "Roles",
      href: `/settings/roles/${r.id}`,
      team: r.team,
      icon: ShieldCheck,
    })),
    ...s.cronJobs.map((c) => ({
      id: `cron:${c.id}`,
      label: c.name,
      hint: c.targetName,
      group: "Cron jobs",
      href:
        c.targetKind === "database"
          ? `/storage/databases/${c.targetRef}/cron-jobs`
          : `/apps/${c.targetRef}/cron-jobs`,
      team: c.team,
      icon: Clock,
    })),
    ...s.templates.map((t) => ({
      id: `template:${t.slug}`,
      label: t.name,
      group: "Templates",
      href: templateHref(t.slug),
      team: null,
      icon: LayoutTemplate,
    })),
  ];
}

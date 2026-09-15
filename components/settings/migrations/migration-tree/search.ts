"use client";

import * as React from "react";

import type { PlanProject, PlanService } from "../types";

function hit(service: PlanService, path: string, terms: string[]): boolean {
  const hay = [path, service.name, service.kind, ...service.domains]
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const nameHit = (name: string, terms: string[]) =>
  terms.every((t) => name.toLowerCase().includes(t));

export function visible(
  projects: PlanProject[],
  terms: string[],
): { projects: Set<string>; environments: Set<string>; services: Set<string> } {
  const out = {
    projects: new Set<string>(),
    environments: new Set<string>(),
    services: new Set<string>(),
  };
  for (const p of projects) {
    const wholeProject = nameHit(p.name, terms);
    let anyEnv = false;
    for (const e of p.environments) {
      const wholeEnv = wholeProject || nameHit(e.name, terms);
      const path = `${p.name} ${e.name}`;
      const services = e.services.filter(
        (s) => wholeEnv || hit(s, path, terms),
      );
      if (services.length === 0 && !wholeEnv) continue;
      anyEnv = true;
      out.environments.add(e.sourceId);
      for (const s of services) out.services.add(s.sourceId);
    }
    if (anyEnv || wholeProject) out.projects.add(p.sourceId);
  }
  return out;
}

export function useTreeSearch(projects: PlanProject[]) {
  const [open, setOpen] = React.useState<Set<string>>(
    () =>
      new Set(
        projects.flatMap((p) => [
          p.sourceId,
          ...p.environments.map((e) => e.sourceId),
        ]),
      ),
  );

  const [query, setQuery] = React.useState("");
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const shown = React.useMemo(
    () => (terms.length === 0 ? null : visible(projects, terms)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, query],
  );

  const isOpen = (id: string) => searching || open.has(id);

  function toggleOpen(id: string) {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  }

  return { query, setQuery, shown, isOpen, toggleOpen };
}

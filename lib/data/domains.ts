import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import type { Domain } from "../types";

const DOMAIN_RE = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;

export async function listDomains(
  projectId?: string,
): Promise<(Domain & { projectName: string; projectSlug: string })[]> {
  await assertUser();
  const d = read();
  return d.domains
    .filter((x) => !projectId || x.projectId === projectId)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((x) => {
      const p = d.projects.find((pp) => pp.id === x.projectId);
      return { ...x, projectName: p?.name ?? "", projectSlug: p?.slug ?? "" };
    });
}

export async function addDomain(
  projectId: string,
  name: string,
): Promise<Domain> {
  const user = await assertUser();
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!DOMAIN_RE.test(clean)) throw new Error("Enter a valid domain name");
  if (read().domains.some((x) => x.name === clean))
    throw new Error("Domain already added");
  const project = read().projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Project not found");

  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name: clean,
    status: "pending",
    primary:
      read().domains.filter((x) => x.projectId === projectId).length === 0,
    redirectTo: null,
    ssl: false,
    createdAt: nowIso(),
  };
  mutate((d) => d.domains.push(domain));
  recordActivity("domain", `Added domain ${clean}`, user.name, projectId);
  return domain;
}

/** Simulate DNS/TLS verification. */
export async function verifyDomain(id: string): Promise<Domain> {
  await assertUser();
  return mutate((d) => {
    const dom = d.domains.find((x) => x.id === id);
    if (!dom) throw new Error("Not found");
    dom.status = "valid";
    dom.ssl = true;
    return dom;
  });
}

export async function setPrimaryDomain(id: string): Promise<void> {
  await assertUser();
  mutate((d) => {
    const dom = d.domains.find((x) => x.id === id);
    if (!dom) throw new Error("Not found");
    for (const x of d.domains)
      if (x.projectId === dom.projectId) x.primary = x.id === id;
  });
}

export async function removeDomain(id: string): Promise<void> {
  const user = await assertUser();
  const dom = read().domains.find((x) => x.id === id);
  if (!dom) throw new Error("Not found");
  mutate((d) => {
    d.domains = d.domains.filter((x) => x.id !== id);
  });
  recordActivity(
    "domain",
    `Removed domain ${dom.name}`,
    user.name,
    dom.projectId,
  );
}

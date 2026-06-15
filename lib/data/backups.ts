import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import type { Backup } from "../types";

export interface BackupDTO extends Backup {
  databaseName: string | null;
  destinationName: string;
}

function toDTO(b: Backup): BackupDTO {
  const d = read();
  return {
    ...b,
    databaseName: b.databaseId
      ? d.databases.find((x) => x.id === b.databaseId)?.name ?? null
      : null,
    destinationName:
      d.s3Destinations.find((x) => x.id === b.destinationId)?.name ?? "—",
  };
}

export async function listBackups(): Promise<BackupDTO[]> {
  await assertUser();
  return read()
    .backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toDTO);
}

export async function createBackup(input: {
  name: string;
  databaseId: string | null;
  destinationId: string;
  schedule: string;
  retentionDays: number;
}): Promise<BackupDTO> {
  const user = await assertUser();
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.destinationId) throw new Error("Select a destination");
  const b: Backup = {
    id: newId("bkp"),
    name: input.name.trim(),
    databaseId: input.databaseId,
    destinationId: input.destinationId,
    schedule: input.schedule || "0 3 * * *",
    retentionDays: Math.max(1, input.retentionDays || 7),
    lastRunAt: null,
    lastStatus: "never",
    enabled: true,
    createdAt: nowIso(),
  };
  mutate((d) => d.backups.push(b));
  recordActivity("backup", `Created backup schedule ${b.name}`, user.name, null);
  return toDTO(b);
}

export async function runBackup(id: string): Promise<void> {
  const user = await assertUser();
  mutate((d) => {
    const b = d.backups.find((x) => x.id === id);
    if (!b) throw new Error("Not found");
    b.lastRunAt = nowIso();
    b.lastStatus = "success";
  });
  recordActivity("backup", `Ran backup manually`, user.name, null);
}

export async function toggleBackup(id: string, enabled: boolean): Promise<void> {
  await assertUser();
  mutate((d) => {
    const b = d.backups.find((x) => x.id === id);
    if (!b) throw new Error("Not found");
    b.enabled = enabled;
  });
}

export async function deleteBackup(id: string): Promise<void> {
  await assertUser();
  mutate((d) => {
    d.backups = d.backups.filter((x) => x.id !== id);
  });
}

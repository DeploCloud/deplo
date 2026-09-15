import type { ID } from "./identity";

export interface Team {
  id: ID;
  name: string;
  slug: string;
  plan: "pro" | "enterprise";
  founderUserId?: ID | null;
  requireTwoFactor?: boolean;
  appOrder?: ID[];
  folderOrder?: ID[];
  avatarUrl: string | null;
  createdAt: string;
}

export type TeamIdentity = Pick<Team, "id" | "name" | "slug" | "avatarUrl">;

export interface TeamSummary extends Team {
  role: string;
  memberCount: number;
  canManage: boolean;
}

export interface Folder {
  id: ID;
  teamId: ID;
  name: string;
  parentId?: ID | null;
  color?: string | null;
  ownerUserId?: ID | null;
  projectId?: ID | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: ID;
  teamId: ID;
  name: string;
  slug: string;
  color?: string | null;
  ownerUserId?: ID | null;
  migrationRunId?: ID | null;
  createdAt: string;
  updatedAt: string;
}

export type EnvironmentKind =
  "development" | "preview" | "production" | "custom";

export interface Environment {
  id: ID;
  projectId: ID;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  gitBranch: string;
  isDefault: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

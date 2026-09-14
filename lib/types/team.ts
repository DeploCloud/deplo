import type { ID } from "./identity";

export interface Team {
  id: ID;
  name: string;
  slug: string;
  plan: "pro" | "enterprise";
  // The team's ABSOLUTE owner - the user who created it, holder of the crown.
  founderUserId?: ID | null;
  // Team-wide 2FA policy: a member without a verified second factor resolves no
  // capabilities here, UI and bearer API alike. Never auto-enabled.
  requireTwoFactor?: boolean;
  // Display order of apps in the Overview grid (project ids, first = top-left).
  // Absent ⇒ newest-updated-first.
  appOrder?: ID[];
  // Display order of FOLDERS in the Overview grid. Stale/missing ids are
  // tolerated exactly like {@link appOrder}.
  folderOrder?: ID[];
  // The team's uploaded image, or null for the monogram. No Gravatar step - a
  // team has no email.
  avatarUrl: string | null;
  createdAt: string;
}

// TeamIdentity - who a team IS, with none of its settings.
export type TeamIdentity = Pick<Team, "id" | "name" | "slug" | "avatarUrl">;

// TeamSummary - a team as shown in the switcher: the user's role in it + its size.
export interface TeamSummary extends Team {
  role: string;
  memberCount: number;
  // Whether this person may change anything in that team's settings.
  canManage: boolean;
}

// Folder - a team-wide grouping of apps shown on the Overview.
export interface Folder {
  id: ID;
  teamId: ID;
  name: string;
  parentId?: ID | null;
  // Accent colour for the folder tile, normalised `#rrggbb`.
  color?: string | null;
  // The creator. Null for legacy folders and after the owner's account is
  // deleted (the FK is `ON DELETE SET NULL`).
  ownerUserId?: ID | null;
  // The {@link Project} CONTAINER this folder lives in (ADR-0008, additive). A
  // `projectId` with no matching project is tolerated and treated as top-level.
  projectId?: ID | null;
  createdAt: string;
  updatedAt: string;
}

// Project - the top-level, team-scoped CONTAINER (ADR-0008). Folders and Apps
// live inside it; a Project never nests in another Project.
export interface Project {
  id: ID;
  teamId: ID;
  name: string;
  // Team-unique, URL-safe key (kept for the legacy `/projects/<slug>` redirect).
  slug: string;
  color?: string | null;
  ownerUserId?: ID | null;
  // The migration still creating this project. See {@link App.migrationRunId}.
  migrationRunId?: ID | null;
  createdAt: string;
  updatedAt: string;
}

// EnvironmentKind - the well-known ROLE of an {@link Environment}, the
// discriminant that keeps legacy `EnvTarget` resolution working.
export type EnvironmentKind =
  "development" | "preview" | "production" | "custom";

// Environment - a per-{@link Project}, first-class ISOLATED deploy target
// (ADR-0008 Phase 3).
export interface Environment {
  id: ID;
  projectId: ID;
  name: string;
  // Stable per-project key (drives the pipeline deploy-key + `?env=` routing).
  slug: string;
  kind: EnvironmentKind;
  // This environment's own git branch (empty ⇒ the app's default branch).
  gitBranch: string;
  // Exactly one environment per project is the default (seeded: Production).
  isDefault: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

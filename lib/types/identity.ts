export type ID = string;

export type Role = "owner" | "member" | "viewer";

// Capability - ONE action a member may do in a team, never a bundle. `view` is
// the always-on floor: every member holds it and it is never offered as a toggle.
export type Capability =
  | "view"
  | "create_apps"
  | "deploy_apps"
  | "rollback_apps"
  | "control_apps"
  | "configure_apps"
  | "delete_apps"
  | "move_apps"
  | "open_app_console"
  | "manage_previews"
  | "manage_crons"
  | "manage_domains"
  | "manage_basic_auth"
  | "manage_env"
  | "reveal_secrets"
  | "create_folders"
  | "organize_folders"
  | "delete_folders"
  | "create_projects"
  | "organize_projects"
  | "delete_projects"
  | "manage_environments"
  | "create_databases"
  | "configure_databases"
  | "control_databases"
  | "delete_databases"
  | "open_database_console"
  | "manage_backups"
  | "restore_backups"
  | "delete_backups"
  | "manage_backup_destinations"
  | "manage_registries"
  | "manage_git"
  | "manage_tokens"
  | "manage_mcp"
  | "manage_notifications"
  | "view_logs"
  | "view_metrics"
  | "manage_monitoring"
  | "view_activity"
  | "manage_members"
  | "manage_roles"
  | "manage_team"
  | "delete_team";

// ALL_CAPABILITIES - canonical order every stored set is normalised to. Keep it
// in step with `CAPABILITY_CATEGORIES` in `lib/capabilities.ts` (a test pins the two).
export const ALL_CAPABILITIES: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  "rollback_apps",
  "control_apps",
  "configure_apps",
  "delete_apps",
  "move_apps",
  "open_app_console",
  "manage_previews",
  "manage_crons",
  "manage_domains",
  "manage_basic_auth",
  "manage_env",
  "reveal_secrets",
  "create_folders",
  "organize_folders",
  "delete_folders",
  "create_projects",
  "organize_projects",
  "delete_projects",
  "manage_environments",
  "create_databases",
  "configure_databases",
  "control_databases",
  "delete_databases",
  "open_database_console",
  "manage_backups",
  "restore_backups",
  "delete_backups",
  "manage_backup_destinations",
  "manage_registries",
  "manage_git",
  "manage_tokens",
  "manage_mcp",
  "manage_notifications",
  "view_logs",
  "view_metrics",
  "manage_monitoring",
  "view_activity",
  "manage_members",
  "manage_roles",
  "manage_team",
  "delete_team",
];

export interface User {
  id: ID;
  email: string;
  // Unique instance-wide handle - the public identity. Lowercased, `[a-z0-9_-]`.
  username: string;
  name: string;
  // Legacy instance-wide role; what a user can do now comes from their
  // {@link Membership} in the active team.
  role: Role;
  // Global-scoped admin, distinct from per-team capabilities.
  isInstanceAdmin?: boolean;
  // Globally suspended: cannot sign in, treated as having no access. Keeps the
  // account and its memberships.
  suspended?: boolean;
  // Instance-wide grant: may publish container ports declared in a compose stack.
  canExposePorts?: boolean;
  // Instance-wide grant: may bind-mount a real HOST path into a container.
  canMountHostVolumes?: boolean;
  avatarColor: string;
  createdAt: string;
}

// PublicUser - DTO safe to send to the client.
export interface PublicUser {
  id: ID;
  email: string;
  username: string;
  name: string;
  role: Role;
  isInstanceAdmin: boolean;
  avatarColor: string;
  // Uploaded image, else Gravatar (when the instance allows it), else null for
  // the {@link avatarColor} monogram. Always COMPUTED server-side, never a column.
  avatarUrl: string | null;
  // Safe to expose: says whether a second factor exists, nothing about it.
  twoFactorEnabled: boolean;
}

// Membership - the join row that makes the app multi-tenant.
export interface Membership {
  id: ID;
  userId: ID;
  teamId: ID;
  role: Role;
  capabilities: Capability[];
  createdAt: string;
}

export type InviteStatus = "pending" | "accepted" | "revoked";

// Invite - accepting one creates the User (if new) and the {@link Membership}.
export interface Invite {
  id: ID;
  teamId: ID;
  email: string;
  role: Role;
  capabilities: Capability[];
  // sha256 of the raw invite token; the raw token is never stored.
  tokenHash: string;
  status: InviteStatus;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

export type RegistrationLinkStatus = "pending" | "used" | "revoked";

// RegistrationLink - single-use link that self-registers a new account AND its
// own team (like first-run setup, not a team invite).
export interface RegistrationLink {
  id: ID;
  // sha256 of the raw token; the raw token lives only in the link.
  tokenHash: string;
  status: RegistrationLinkStatus;
  createdBy: string;
  usedByUsername: string | null;
  // 24h after minting; enforced on every read and at consume.
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface ApiToken {
  id: ID;
  teamId: ID;
  // The principal a bearer request authenticated with this token resolves to
  // for user-scoped fields (account, instance-admin checks).
  userId: ID;
  name: string;
  // sha256 of the token; raw is shown once on creation.
  tokenHash: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

// VarAuthor - who created or last modified a variable. Identity fields only:
// never an email, never a hash.
export interface VarAuthor {
  id: ID;
  name: string;
  username: string;
  avatarColor: string;
  // Resolved picture: uploaded image, else Gravatar, else null. See
  // {@link PublicUser.avatarUrl} - the address itself never reaches here.
  avatarUrl: string | null;
}

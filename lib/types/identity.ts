export type ID = string;

export type Role = "owner" | "member" | "viewer";

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
  username: string;
  name: string;
  role: Role;
  isInstanceAdmin?: boolean;
  suspended?: boolean;
  canExposePorts?: boolean;
  canMountHostVolumes?: boolean;
  avatarColor: string;
  createdAt: string;
}

export interface PublicUser {
  id: ID;
  email: string;
  username: string;
  name: string;
  role: Role;
  isInstanceAdmin: boolean;
  avatarColor: string;
  avatarUrl: string | null;
  twoFactorEnabled: boolean;
}

export interface Membership {
  id: ID;
  userId: ID;
  teamId: ID;
  role: Role;
  capabilities: Capability[];
  createdAt: string;
}

export type InviteStatus = "pending" | "accepted" | "revoked";

export interface Invite {
  id: ID;
  teamId: ID;
  email: string;
  role: Role;
  capabilities: Capability[];
  tokenHash: string;
  status: InviteStatus;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

export type RegistrationLinkStatus = "pending" | "used" | "revoked";

export interface RegistrationLink {
  id: ID;
  tokenHash: string;
  status: RegistrationLinkStatus;
  createdBy: string;
  usedByUsername: string | null;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface ApiToken {
  id: ID;
  teamId: ID;
  userId: ID;
  name: string;
  tokenHash: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface VarAuthor {
  id: ID;
  name: string;
  username: string;
  avatarColor: string;
  avatarUrl: string | null;
}

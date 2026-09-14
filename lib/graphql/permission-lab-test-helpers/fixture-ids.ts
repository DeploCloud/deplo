import { capabilitiesForRole } from "../../membership-shared";
import type { Capability } from "../../types/identity";

export const T0 = "2026-01-01T00:00:00.000Z";
export const TEAM = "team_lab";
export const OTHER = "team_other";

export const OWNER = "u_owner";
export const VIEWER = "u_viewer";
export const MEMBER = "u_member";
export const DEPLOYER = "u_deployer";
export const OPS = "u_ops";
export const DBA = "u_dba";
export const HR = "u_hr";
export const CONTRACTOR = "u_contractor";
export const STAGER = "u_stager";
export const FOLDERDEV = "u_folderdev";
export const SOLO = "u_solo";
export const GRANTEE = "u_grantee";
export const NEWBIE = "u_newbie";
export const STRANGER = "u_stranger";
// SYSADMIN is an instance admin who is NOT in the lab team.
export const SYSADMIN = "u_sysadmin";
// OWNER2 is an assigned (non-founder) Owner of the lab team.
export const OWNER2 = "u_owner2";

export const PRJ_A = "prc_a";
export const PRJ_B = "prc_b";
export const ENV_PROD = "environ_prod";
export const ENV_STG = "environ_stg";
export const ENV_B = "environ_b";
export const FLD_F = "fld_f";
export const FLD_F_CHILD = "fld_f_child";
export const FLD_P = "fld_p";
export const APP_A_PROD = "prj_a_prod";
export const APP_A_STG = "prj_a_stg";
export const APP_B = "prj_b";
export const APP_F = "prj_f";
export const APP_F_CHILD = "prj_f_child";
export const APP_P = "prj_p";
export const APP_TOP = "prj_top";
export const APP_X = "prj_x";
export const DEP_TOP = "dpl_top";
export const DEP_OLD = "dpl_old";
export const DB_1 = "db_1";
export const ROLE_PRJ = "role_prj";
export const ROLE_ENV = "role_env";
export const ROLE_FLD = "role_fld";

export const VIEWER_CAPS = capabilitiesForRole("viewer");
export const DEPLOYER_CAPS: Capability[] = ["view", "deploy_apps", "view_logs"];
export const OPS_CAPS: Capability[] = [
  "view",
  "control_apps",
  "view_logs",
  "view_metrics",
];
export const DBA_CAPS: Capability[] = [
  "view",
  "create_databases",
  "configure_databases",
  "control_databases",
  "delete_databases",
  "open_database_console",
  "reveal_secrets",
  "manage_backups",
];
export const HR_CAPS: Capability[] = [
  ...VIEWER_CAPS,
  "manage_members",
  "manage_roles",
];
// SCOPED_CAPS is what a contractor's role is authored with; its scope removes the team-wide part.
export const SCOPED_CAPS: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  "configure_apps",
  "manage_env",
  "view_logs",
];
export const SOLO_GRANT: Capability[] = [
  "deploy_apps",
  "configure_apps",
  "manage_env",
  "view_logs",
];

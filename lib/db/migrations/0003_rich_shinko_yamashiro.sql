CREATE TYPE "public"."deployment_log_level" AS ENUM('info', 'warn', 'error', 'debug', 'command', 'success');--> statement-breakpoint
CREATE TYPE "public"."dev_status" AS ENUM('off', 'starting', 'running', 'stopped', 'error');--> statement-breakpoint
CREATE TYPE "public"."github_account_type" AS ENUM('User', 'Organization');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "activities_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" text NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"actor" text NOT NULL,
	"project_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "backup_runs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" text NOT NULL,
	"backup_id" text,
	"target_kind" text NOT NULL,
	"database_id" text,
	"project_id" text,
	"destination_id" text NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"target_kind" text NOT NULL,
	"database_id" text,
	"project_id" text,
	"destination_id" text NOT NULL,
	"schedule" text NOT NULL,
	"retention_days" integer NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "backups_target_kind_xor" CHECK (("backups"."target_kind" = 'database' and "backups"."database_id" is not null and "backups"."project_id" is null)
          or ("backups"."target_kind" = 'project' and "backups"."project_id" is not null and "backups"."database_id" is null))
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"server_id" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"connection_string_enc" text NOT NULL,
	"exposed_publicly" boolean NOT NULL,
	"size_mb" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deployment_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"deployment_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"level" "deployment_log_level" NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "deployments_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" text NOT NULL,
	"status" text NOT NULL,
	"environment" text NOT NULL,
	"commit_sha" text NOT NULL,
	"commit_message" text NOT NULL,
	"commit_author" text NOT NULL,
	"branch" text NOT NULL,
	"url" text NOT NULL,
	"ready_at" timestamp with time zone,
	"build_duration_ms" bigint,
	"creator" text NOT NULL,
	"build_source" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dev_ssh_user" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"username" text NOT NULL,
	"public_key" text,
	"password_enc" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dev_ssh_user_has_credential" CHECK ("dev_ssh_user"."public_key" is not null or "dev_ssh_user"."password_enc" is not null)
);
--> statement-breakpoint
CREATE TABLE "domain_middlewares" (
	"domain_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "domain_middlewares_domain_id_position_pk" PRIMARY KEY("domain_id","position")
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"is_primary" boolean NOT NULL,
	"redirect_to" text,
	"ssl" boolean NOT NULL,
	"source" text,
	"port" integer,
	"entrypoint" text,
	"cert_provider" text,
	"path_prefix" text,
	"strip_prefix" boolean,
	"service" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_var_targets" (
	"env_var_id" text NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "env_var_targets_env_var_id_target_pk" PRIMARY KEY("env_var_id","target")
);
--> statement-breakpoint
CREATE TABLE "env_vars" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"color" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"html_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" "github_account_type" NOT NULL,
	"avatar_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installed_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"catalog_id" text NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_capabilities" (
	"invite_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "invite_capabilities_invite_id_capability_pk" PRIMARY KEY("invite_id","capability")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "membership_capabilities" (
	"membership_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "membership_capabilities_membership_id_capability_pk" PRIMARY KEY("membership_id","capability")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"team_id" text PRIMARY KEY NOT NULL,
	"push_enabled" boolean NOT NULL,
	"email_enabled" boolean NOT NULL,
	"email_address" text NOT NULL,
	"discord_enabled" boolean NOT NULL,
	"discord_webhook_url" text NOT NULL,
	"webhook_enabled" boolean NOT NULL,
	"webhook_url" text NOT NULL,
	"deployment_failed" boolean NOT NULL,
	"deployment_succeeded" boolean NOT NULL,
	"server_offline" boolean NOT NULL,
	"high_resource_usage" boolean NOT NULL,
	"update_available" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_build" (
	"project_id" text PRIMARY KEY NOT NULL,
	"framework" text NOT NULL,
	"build_method" text NOT NULL,
	"root_directory" text NOT NULL,
	"install_command" text NOT NULL,
	"build_command" text NOT NULL,
	"output_directory" text NOT NULL,
	"start_command" text NOT NULL,
	"runtime_version" text NOT NULL,
	"port" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_build_method_settings" (
	"project_id" text PRIMARY KEY NOT NULL,
	"dockerfile_path" text,
	"docker_context_path" text,
	"docker_build_stage" text,
	"railpack_version" text,
	"nixpacks_publish_directory" text,
	"heroku_version" text,
	"static_single_page_app" boolean
);
--> statement-breakpoint
CREATE TABLE "project_dev" (
	"project_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"status" "dev_status" NOT NULL,
	"image_kind" text NOT NULL,
	"image" text NOT NULL,
	"dev_command" text NOT NULL,
	"port" integer NOT NULL,
	"preview_enabled" boolean NOT NULL,
	"latest_start_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_exposes" (
	"project_id" text NOT NULL,
	"position" integer NOT NULL,
	"service" text NOT NULL,
	"port" integer NOT NULL,
	"host" text,
	CONSTRAINT "project_exposes_project_id_position_pk" PRIMARY KEY("project_id","position")
);
--> statement-breakpoint
CREATE TABLE "project_mounts" (
	"project_id" text NOT NULL,
	"position" integer NOT NULL,
	"file_path" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "project_mounts_project_id_position_pk" PRIMARY KEY("project_id","position")
);
--> statement-breakpoint
CREATE TABLE "project_volumes" (
	"project_id" text NOT NULL,
	"position" integer NOT NULL,
	"volume_id" text NOT NULL,
	"type" text,
	"name" text NOT NULL,
	"project_path" text,
	"host_path" text,
	"mount_path" text NOT NULL,
	"read_only" boolean NOT NULL,
	CONSTRAINT "project_volumes_project_id_position_pk" PRIMARY KEY("project_id","position")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"team_id" text NOT NULL,
	"folder_id" text,
	"server_id" text NOT NULL,
	"framework" text NOT NULL,
	"logo" text,
	"source" text NOT NULL,
	"repo_provider" text,
	"repo_url" text,
	"repo_repo" text,
	"repo_branch" text,
	"repo_installation_id" text,
	"docker_image" text,
	"upload_id" text,
	"upload_filename" text,
	"upload_path" text,
	"upload_size" bigint,
	"upload_uploaded_at" timestamp with time zone,
	"compose" text,
	"production_url" text,
	"status" text NOT NULL,
	"auto_deploy" boolean NOT NULL,
	"latest_deployment_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_links" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"used_by_username" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registries" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"registry_url" text NOT NULL,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "s3_destination" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"access_key_enc" text NOT NULL,
	"secret_key_enc" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"ip" text NOT NULL,
	"docker_version" text NOT NULL,
	"traefik_enabled" boolean NOT NULL,
	"cpu_cores" integer NOT NULL,
	"memory_mb" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"cpu_usage" integer NOT NULL,
	"memory_usage" integer NOT NULL,
	"disk_usage" integer NOT NULL,
	"agent_port" integer,
	"agent_cert_fingerprint" text,
	"agent_cert_pem" text,
	"agent_version" text,
	"bootstrap_token_hash" text,
	"bootstrap_expires_at" timestamp with time zone,
	"bootstrap_used_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_env_group_projects" (
	"group_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "shared_env_group_projects_group_id_project_id_pk" PRIMARY KEY("group_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "shared_env_group_targets" (
	"group_id" text NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "shared_env_group_targets_group_id_target_pk" PRIMARY KEY("group_id","target")
);
--> statement-breakpoint
CREATE TABLE "shared_env_group_vars" (
	"group_id" text NOT NULL,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "shared_env_group_vars_group_id_key_pk" PRIMARY KEY("group_id","key")
);
--> statement-breakpoint
CREATE TABLE "shared_env_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_migration" (
	"name" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_folder_order" (
	"team_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "team_folder_order_team_id_folder_id_pk" PRIMARY KEY("team_id","folder_id")
);
--> statement-breakpoint
CREATE TABLE "team_project_order" (
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "team_project_order_team_id_project_id_pk" PRIMARY KEY("team_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"is_instance_admin" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"can_expose_ports" boolean DEFAULT false NOT NULL,
	"can_mount_host_volumes" boolean DEFAULT false NOT NULL,
	"avatar_color" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_destination_id_s3_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destination"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_destination_id_s3_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destination"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_ssh_user" ADD CONSTRAINT "dev_ssh_user_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_middlewares" ADD CONSTRAINT "domain_middlewares_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_var_targets" ADD CONSTRAINT "env_var_targets_env_var_id_env_vars_id_fk" FOREIGN KEY ("env_var_id") REFERENCES "public"."env_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_app_id_github_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."github_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_apps" ADD CONSTRAINT "installed_apps_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_capabilities" ADD CONSTRAINT "invite_capabilities_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_capabilities" ADD CONSTRAINT "membership_capabilities_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_build" ADD CONSTRAINT "project_build_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_build_method_settings" ADD CONSTRAINT "project_build_method_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dev" ADD CONSTRAINT "project_dev_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_exposes" ADD CONSTRAINT "project_exposes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mounts" ADD CONSTRAINT "project_mounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_volumes" ADD CONSTRAINT "project_volumes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_latest_deployment_id_deployments_id_fk" FOREIGN KEY ("latest_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registries" ADD CONSTRAINT "registries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD CONSTRAINT "s3_destination_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_group_projects" ADD CONSTRAINT "shared_env_group_projects_group_id_shared_env_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."shared_env_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_group_projects" ADD CONSTRAINT "shared_env_group_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_group_targets" ADD CONSTRAINT "shared_env_group_targets_group_id_shared_env_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."shared_env_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_group_vars" ADD CONSTRAINT "shared_env_group_vars_group_id_shared_env_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."shared_env_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_groups" ADD CONSTRAINT "shared_env_groups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_folder_order" ADD CONSTRAINT "team_folder_order_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_folder_order" ADD CONSTRAINT "team_folder_order_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_project_order" ADD CONSTRAINT "team_project_order_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_project_order" ADD CONSTRAINT "team_project_order_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_team_created_idx" ON "activities" USING btree ("team_id","created_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_uq" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "backup_runs_team_started_idx" ON "backup_runs" USING btree ("team_id","started_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backup_runs_running_idx" ON "backup_runs" USING btree ("status") WHERE "backup_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "databases_team_name_uq" ON "databases" USING btree ("team_id","name");--> statement-breakpoint
CREATE INDEX "deployment_logs_deployment_idx" ON "deployment_logs" USING btree ("deployment_id","id");--> statement-breakpoint
CREATE INDEX "deployments_project_created_idx" ON "deployments" USING btree ("project_id","created_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "dev_ssh_user_username_uq" ON "dev_ssh_user" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_one_primary_uq" ON "domains" USING btree ("project_id") WHERE "domains"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_pathprefix_uq" ON "domains" USING btree ("name",coalesce("path_prefix", ''));--> statement-breakpoint
CREATE INDEX "domains_project_idx" ON "domains" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "env_vars_project_key_uq" ON "env_vars" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "github_apps_app_id_uq" ON "github_apps" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installation_installation_id_uq" ON "github_installation" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installed_apps_team_catalog_uq" ON "installed_apps" USING btree ("team_id","catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installed_apps_slug_uq" ON "installed_apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "installed_apps_team_created_idx" ON "installed_apps" USING btree ("team_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_uq" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_team_email_pending_uq" ON "invites" USING btree ("team_id","email") WHERE "invites"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_team_uq" ON "memberships" USING btree ("user_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uq" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_team_idx" ON "projects" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "projects_folder_idx" ON "projects" USING btree ("folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_links_token_hash_uq" ON "registration_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "registries_team_created_idx" ON "registries" USING btree ("team_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "s3_destination_team_created_idx" ON "s3_destination" USING btree ("team_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "servers_cert_fingerprint_uq" ON "servers" USING btree ("agent_cert_fingerprint") WHERE "servers"."agent_cert_fingerprint" is not null and "servers"."agent_cert_fingerprint" <> '';--> statement-breakpoint
CREATE INDEX "servers_bootstrap_token_idx" ON "servers" USING btree ("bootstrap_token_hash") WHERE "servers"."bootstrap_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "shared_env_group_projects_project_idx" ON "shared_env_group_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_slug_uq" ON "teams" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username");
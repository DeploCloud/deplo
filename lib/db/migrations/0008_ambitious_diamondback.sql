CREATE TABLE "instance_env_var_targets" (
	"env_var_id" text NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "instance_env_var_targets_env_var_id_target_pk" PRIMARY KEY("env_var_id","target")
);
--> statement-breakpoint
CREATE TABLE "instance_env_vars" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_global_env_var_targets" (
	"env_var_id" text NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "team_global_env_var_targets_env_var_id_target_pk" PRIMARY KEY("env_var_id","target")
);
--> statement-breakpoint
CREATE TABLE "team_global_env_vars" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_env_var_targets" ADD CONSTRAINT "instance_env_var_targets_env_var_id_instance_env_vars_id_fk" FOREIGN KEY ("env_var_id") REFERENCES "public"."instance_env_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_global_env_var_targets" ADD CONSTRAINT "team_global_env_var_targets_env_var_id_team_global_env_vars_id_fk" FOREIGN KEY ("env_var_id") REFERENCES "public"."team_global_env_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_global_env_vars" ADD CONSTRAINT "team_global_env_vars_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_env_vars_key_uq" ON "instance_env_vars" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "team_global_env_vars_team_key_uq" ON "team_global_env_vars" USING btree ("team_id","key");
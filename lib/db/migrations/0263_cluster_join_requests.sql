CREATE TABLE "cluster_join_requests" (
	"server_id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"requested_by_user_id" text,
	"requested_by_team_id" text,
	"error" text DEFAULT '' NOT NULL,
	"tried_at" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_join_requests" ADD CONSTRAINT "cluster_join_requests_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_join_requests" ADD CONSTRAINT "cluster_join_requests_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_join_requests" ADD CONSTRAINT "cluster_join_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_join_requests" ADD CONSTRAINT "cluster_join_requests_requested_by_team_id_teams_id_fk" FOREIGN KEY ("requested_by_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
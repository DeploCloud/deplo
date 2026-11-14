-- What is wrong with a cluster, worked out in the background so the Servers page never waits on a leader.
CREATE TABLE "cluster_warnings" (
	"cluster_id" text NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"start_leader" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cluster_warnings_cluster_id_key_pk" PRIMARY KEY("cluster_id","key")
);
--> statement-breakpoint
ALTER TABLE "cluster_warnings" ADD CONSTRAINT "cluster_warnings_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;
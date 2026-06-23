CREATE TABLE "scheduler_lease" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL
);

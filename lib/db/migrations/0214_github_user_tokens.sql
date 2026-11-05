CREATE TABLE "github_user_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"token_enc" text NOT NULL,
	"expires_at" timestamp with time zone,
	"refresh_token_enc" text,
	"refresh_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_user_tokens" ADD CONSTRAINT "github_user_tokens_app_id_github_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."github_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_user_tokens" ADD CONSTRAINT "github_user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_user_tokens_app_user_uq" ON "github_user_tokens" USING btree ("app_id","user_id");
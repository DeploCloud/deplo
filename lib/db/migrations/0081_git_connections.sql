-- Git providers beyond GitHub: GitLab, Bitbucket, Gitea/Forgejo and plain git.
--
-- A "git connection" is a team's credentials for ONE git host. It is the
-- counterpart of github_installation, and it exists as a single table with a
-- `provider` discriminator (rather than three near-identical tables) because
-- every non-GitHub provider authenticates the same way: a long-lived token used
-- as HTTP basic auth on the clone URL and on the REST API. Only GitHub needs its
-- own shape, and it already has one (a registered App with a private key minting
-- short-lived installation tokens).
--
-- webhook_token is the opaque segment of /api/git/webhook/<token>. It routes a
-- delivery to its connection, so the handler knows which provider sent it and
-- which secret verifies it without sniffing headers. UNIQUE because it is a
-- routing key; unguessable because for Bitbucket without a configured secret it
-- IS the shared secret (Bitbucket signs only when a secret is set).
CREATE TABLE "git_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"username" text NOT NULL,
	"token_enc" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"webhook_token" text NOT NULL,
	"account_login" text DEFAULT '' NOT NULL,
	"avatar_url" text DEFAULT '' NOT NULL,
	"health" text DEFAULT 'ok' NOT NULL,
	"health_error" text DEFAULT '' NOT NULL,
	"token_expires_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "git_connections_webhook_token_uq" ON "git_connections" ("webhook_token");
--> statement-breakpoint
CREATE INDEX "git_connections_team_idx" ON "git_connections" ("team_id");
--> statement-breakpoint
-- Which connection authenticates an app's clone. NULL for a GitHub App repo
-- (repo_installation_id carries that) and for a public repo cloned anonymously,
-- which is every pre-existing source='git' app — hence no backfill: they keep
-- behaving exactly as before.
--
-- Deliberately NOT a foreign key, mirroring repo_installation_id: deleting a
-- connection clears this column with an explicit UPDATE in the same transaction,
-- so unlinking an app is a write someone can read in the code rather than a
-- cascade that happens invisibly.
ALTER TABLE "apps" ADD COLUMN "repo_connection_id" text;

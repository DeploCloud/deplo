-- An API token becomes a principal with its OWN capabilities.
--
-- Until now a `deplo_` token was root by construction: it resolved to its creator
-- and then did whatever that member could do, so "a token that can only deploy"
-- was unsayable. deplo gates forty fine-grained capabilities for people and then
-- handed a bearer credential every one of them.
--
-- From here every token carries a mandatory capability set (the same forty from
-- lib/capabilities.ts a Role is built from), an optional PROJECT scope, and an
-- opt-in instance-admin bit. Enforcement stays a read of the effective set: the
-- bearer path INTERSECTS the member's live capabilities with the token's, so a
-- token can never do more than its creator and usually does much less. No new
-- authorization concept, one extra intersection in the existing gate.
--
-- `project_scoped` is deliberately a column and not "zero rows in the junction":
-- deleting a Project cascades its `api_token_projects` rows away, and without the
-- flag an emptied scope would read as "unscoped" and silently WIDEN the token to
-- the whole team. Scoped with no rows means it reaches nothing.
--
-- This migration changes NOBODY's access. Every existing token is backfilled with
-- its creator's current effective capabilities in the token's own team, gets no
-- project rows (unscoped, which is what it reaches today), and gets
-- instance_admin = false - implicit root is exactly what is being removed, so it
-- is not carried forward; an instance admin can turn it back on per token.
CREATE TABLE "api_token_capabilities" (
	"token_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "api_token_capabilities_token_id_capability_pk" PRIMARY KEY("token_id","capability"),
	CONSTRAINT "api_token_capabilities_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "api_token_projects" (
	"token_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "api_token_projects_token_id_project_id_pk" PRIMARY KEY("token_id","project_id"),
	CONSTRAINT "api_token_projects_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE cascade,
	CONSTRAINT "api_token_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "api_token_projects_project_idx" ON "api_token_projects" ("project_id");
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "instance_admin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "project_scoped" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill: exactly what each token can do TODAY - its creator's effective
-- capabilities in the token's own team, read from the same junction every
-- authorization check reads.
INSERT INTO "api_token_capabilities" ("token_id", "capability")
SELECT t."id", mc."capability"
FROM "api_tokens" t
JOIN "memberships" m
  ON m."user_id" = t."user_id" AND m."team_id" = t."team_id"
JOIN "membership_capabilities" mc ON mc."membership_id" = m."id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- A token whose creator has since left the team already resolves nothing
-- (authenticateToken fails closed on a missing membership). Give it the `view`
-- floor rather than an empty set, so "no rows" never has two meanings.
INSERT INTO "api_token_capabilities" ("token_id", "capability")
SELECT t."id", 'view'
FROM "api_tokens" t
WHERE NOT EXISTS (
  SELECT 1 FROM "api_token_capabilities" c WHERE c."token_id" = t."id"
)
ON CONFLICT DO NOTHING;

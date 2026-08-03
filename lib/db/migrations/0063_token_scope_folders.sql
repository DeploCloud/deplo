-- Folders join the token scope tree.
--
-- 0062 made the scope a tree of teams, projects and apps — and left out the level
-- most apps actually live in. Filing an app into a Folder CLEARS its own
-- `project_id` (see `resolveNewAppPlacement`), so on any real instance the
-- picker showed nearly every app under "Apps outside a project", which is both
-- useless and untrue: they are in a folder, and that folder may itself sit
-- inside a project.
--
-- A folder row means "this folder and everything under it": its apps, its
-- subfolders, and their apps, however deep. The subtree is expanded at
-- authentication time rather than stored, so moving or nesting a folder takes
-- effect immediately and nothing has to be re-materialized.
--
-- Ticking a PROJECT keeps covering everything filed under it, folders included —
-- that expansion is resolved the same way, by walking each folder's parent chain
-- to its project.
CREATE TABLE "api_token_folders" (
	"token_id" text NOT NULL,
	"folder_id" text NOT NULL,
	CONSTRAINT "api_token_folders_token_id_folder_id_pk" PRIMARY KEY("token_id","folder_id"),
	CONSTRAINT "api_token_folders_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE cascade,
	CONSTRAINT "api_token_folders_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "api_token_folders_folder_idx" ON "api_token_folders" ("folder_id");

-- Pull request previews get a settings page of their own, and six more knobs to
-- put on it. Every column is nullable-or-defaulted so an app that never opens the
-- page behaves exactly as it did: previews stay OFF until somebody says otherwise,
-- and each setting's absent value is the platform default.

-- HTTPS on preview hosts. Only meaningful once `preview_base_domain` is set: a
-- nip.io host can never hold a certificate — it is ONE registered domain whose
-- Let's Encrypt budget is shared with the entire internet — so the switch stays
-- off and disabled until a base domain exists. On ⇒ each preview host gets its own
-- HTTP-01 certificate from the resolver that already exists; off ⇒ plain HTTP,
-- which is a legitimate choice on a domain you own.
ALTER TABLE "apps" ADD COLUMN "preview_https" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Rebuild a preview when its pull request receives a new commit. Off ⇒ built once,
-- refreshed only by a person — what a team on a heavy image or paying per build
-- minute wants. Deliberately NOT `apps.auto_deploy`: turning deploy-on-push off for
-- PRODUCTION is about release control and says nothing about pull requests.
ALTER TABLE "apps" ADD COLUMN "preview_auto_deploy" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Container port a preview routes to. NULL ⇒ the app's build port, which is what
-- keeps a preview faithful to production; set only when the branch genuinely
-- listens somewhere else.
ALTER TABLE "apps" ADD COLUMN "preview_port" integer;
--> statement-breakpoint
-- Build a pull request while it is still a draft. Off by default: a draft is work
-- in progress, and a container for it burns a slot nobody asked for. The manual
-- "Deploy a pull request" action stays the per-case escape hatch.
ALTER TABLE "apps" ADD COLUMN "preview_build_drafts" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Post and keep updating the one sticky comment carrying the preview URL. On by
-- default — that comment is where a reviewer actually looks — but it needs
-- `pull_requests: write` on the GitHub App, so an instance that will not grant it
-- can stop attempting instead of collecting 403s.
ALTER TABLE "apps" ADD COLUMN "preview_comment" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Newline-separated pull request LABELS that gate a preview: a pull request must
-- carry at least one of them to get one. NULL/empty ⇒ no filter.
--
-- Stored exactly like `repo_watch_paths` on this same table — a newline list of
-- match strings belonging to the app's git configuration, split at the edge that
-- reads it. A junction table is the house rule for a list, and it is the right
-- rule when the rows are entities with their own identity and ordering; these are
-- two or three opaque strings whose only operation is "does the pull request carry
-- one", and giving them a table would make them look like something you can point
-- at from elsewhere. Deliberate, and consistent with its nearest sibling.
ALTER TABLE "apps" ADD COLUMN "preview_required_labels" text;
--> statement-breakpoint
-- The port a preview's router forwards to, minted from the app's setting when the
-- preview is created.
--
-- Denormalized onto the preview for the same reason `cert_provider` already is:
-- `runDeployment` re-reads the PREVIEW ROW, never the app's settings, so anything
-- the renderer needs must live here. It also freezes the value — changing the
-- setting must not silently repoint a preview somebody is already testing.
ALTER TABLE "app_previews" ADD COLUMN "port" integer;

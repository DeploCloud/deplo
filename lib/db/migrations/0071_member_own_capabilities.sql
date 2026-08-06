-- One member's own capability set, kept out of the role's way.
--
-- A team Role writes `membership_capabilities` for everyone who holds it, every
-- time it is saved (`syncMembersOfRole`). That is what makes "edit the role,
-- every holder follows" true — and it is also why a per-member adjustment was
-- impossible: an admin who took `delete_apps` away from one person got it
-- handed back the next time somebody renamed the role.
--
-- This flag says "this member's set is their own". It is written by the member
-- page when the saved set differs from what the role would give, and the role
-- sync skips those memberships. Everyone else — the overwhelming majority —
-- keeps following their role exactly as before.
--
-- Nothing is backfilled: every existing membership matches its role today, so
-- false is the truth for all of them.
ALTER TABLE "memberships"
  ADD COLUMN IF NOT EXISTS "custom_capabilities" boolean DEFAULT false NOT NULL;

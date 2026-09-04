-- A token belongs to a person, not to a team: the "home team" is gone, and with
-- it the cascade that deleted a personal credential when one team was deleted.
ALTER TABLE "api_tokens" DROP COLUMN "team_id";

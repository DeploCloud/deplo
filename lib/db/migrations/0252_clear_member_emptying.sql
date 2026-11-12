-- "Empty" is gone: a member that was emptied, or being emptied, takes work again (Remove now moves things first).
UPDATE "cluster_members" SET "emptying_since" = NULL, "emptying_error" = '', "emptying_workload" = '', "emptying_workload_kind" = '', "emptying_total" = 0, "emptying_team_id" = NULL WHERE "emptying_since" IS NOT NULL;

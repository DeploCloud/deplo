-- A cleanup scope the code has retired is a row nothing can ever request again.
--
-- `orphan_buildkit_cache` was superseded by `orphan_volumes` in September 2026 (a
-- buildkit store is one anonymous volume), but the stored row outlived the rename
-- and rode along in every policy read, filtered out by effectiveScopes
-- (lib/data/docker-cleanup/scopes.ts). This keeps the table to the scopes the
-- control plane can actually send, and changes nothing about what gets swept:
-- effectiveScopes already turns `orphan_volumes` on for any policy saved before
-- it existed.
DELETE FROM docker_cleanup_policy_scopes
WHERE scope NOT IN (
  'build_cache',
  'dangling_images',
  'orphan_volumes',
  'unused_app_images',
  'unused_pulled_images',
  'leftover_app_files',
  'leftover_networks'
);

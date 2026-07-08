-- Cross-host data migration on a service server MOVE. A service gains a NULLABLE
-- `migrate_from_server_id`: set on a move when the OLD server still holds the
-- service's data (a running stack), it names the source host the NEXT successful
-- deploy on the new server copies the data volumes + files dir FROM (host-to-host,
-- via the agent ExportVolume/ImportVolume + ExportFiles/ImportFiles RPCs). The
-- deploy clears it once the copy + old-host teardown complete. Purely additive:
-- existing services get NULL (no pending migration). ON DELETE SET NULL so deleting
-- the source server drops the marker instead of blocking the delete.
ALTER TABLE "services" ADD COLUMN "migrate_from_server_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_migrate_from_server_id_servers_id_fk" FOREIGN KEY ("migrate_from_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;

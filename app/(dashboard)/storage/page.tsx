import { Database, Cloud, Archive } from "lucide-react";
import { listDatabases } from "@/lib/data/databases";
import { listS3 } from "@/lib/data/s3";
import { listBackups } from "@/lib/data/backups";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { listProjects } from "@/lib/data/projects";
import { canExposePorts } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateDatabase } from "@/components/storage/create-database";
import { DatabaseCard } from "@/components/storage/database-card";
import { CreateS3 } from "@/components/storage/create-s3";
import { S3Card } from "@/components/storage/s3-card";
import { CreateBackup } from "@/components/storage/create-backup";
import { BackupRow } from "@/components/storage/backup-row";

export const metadata = { title: "Storage" };

export default async function StoragePage(props: PageProps<"/storage">) {
  // "New ▸ …" actions (the global context menu / Overview) link here with
  // ?new=database|s3|backup so the matching create dialog opens straight away on
  // the right tab.
  const { new: newParam } = await props.searchParams;
  const newKind = Array.isArray(newParam) ? newParam[0] : newParam;
  const autoOpenDatabase = newKind === "database";
  const autoOpenS3 = newKind === "s3";
  const autoOpenBackup = newKind === "backup";
  const initialTab =
    newKind === "s3" ? "s3" : newKind === "backup" ? "backups" : "databases";

  const [databases, destinations, backups, servers, projects, mayExposePorts] =
    await Promise.all([
      listDatabases(),
      listS3(),
      listBackups(),
      listServersForCurrentTeam(),
      listProjects(),
      // Gates the "Expose publicly" toggle: only a user with the publish-ports
      // grant may open a database to the internet (same grant as a project's
      // compose `ports:`). Server-enforced too — this only hides the affordance.
      canExposePorts(),
    ]);

  // Only provisioned servers can host a database (provisioning routes through a
  // live agent). A server is provisioned once its agent has called home and
  // pinned a cert fingerprint.
  const dbServers = servers
    .filter((s) => Boolean(s.agent?.certFingerprint))
    .map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Storage"
        description="Managed databases, S3 destinations and scheduled backups."
      />

      <Tabs defaultValue={initialTab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="databases">
            Databases
            <Badge variant="muted" className="ml-2">
              {databases.length}
            </Badge>
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="s3">
            S3 Destinations
            <Badge variant="muted" className="ml-2">
              {destinations.length}
            </Badge>
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="backups">
            Backups
            <Badge variant="muted" className="ml-2">
              {backups.length}
            </Badge>
          </UnderlineTabsTrigger>
        </UnderlineTabsList>

        {/* Databases */}
        <TabsContent value="databases" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              PostgreSQL, MySQL, MongoDB, Redis and more provisioned on your
              servers.
            </p>
            <CreateDatabase
              servers={dbServers}
              canExposePorts={mayExposePorts}
              autoOpen={autoOpenDatabase}
            />
          </div>
          {databases.length === 0 ? (
            <EmptyState
              icon={Database}
              title="No databases yet"
              description="Create a managed database to connect to your apps."
              action={
                <CreateDatabase
                  servers={dbServers}
                  canExposePorts={mayExposePorts}
                />
              }
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {databases.map((db) => (
                <DatabaseCard
                  key={db.id}
                  db={db}
                  canExposePorts={mayExposePorts}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* S3 destinations */}
        <TabsContent value="s3" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Connect any S3-compatible storage for backups and assets.
            </p>
            <CreateS3 autoOpen={autoOpenS3} />
          </div>
          {destinations.length === 0 ? (
            <EmptyState
              icon={Cloud}
              title="No S3 destinations"
              description="Add a bucket (R2, S3, B2, MinIO…) to store backups and assets."
              action={<CreateS3 />}
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {destinations.map((dest) => (
                <S3Card key={dest.id} dest={dest} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Backups */}
        <TabsContent value="backups" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Scheduled database backups pushed to your S3 destinations.
            </p>
            <CreateBackup
              databases={databases.map((d) => ({ id: d.id, name: d.name }))}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
              destinations={destinations.map((d) => ({
                id: d.id,
                name: d.name,
              }))}
              autoOpen={autoOpenBackup}
            />
          </div>
          {backups.length === 0 ? (
            <EmptyState
              icon={Archive}
              title="No backups scheduled"
              description="Schedule automatic backups of your databases to S3."
            />
          ) : (
            <div className="rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Retention</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backups.map((b) => (
                    <BackupRow
                      key={b.id}
                      backup={b}
                      destinations={destinations.map((d) => ({
                        id: d.id,
                        name: d.name,
                      }))}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

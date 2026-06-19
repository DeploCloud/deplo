import { requireUser } from "@/lib/auth";
import { currentCapabilities } from "@/lib/membership";
import { buildApiCatalog } from "@/lib/graphql/introspect";
import { PageHeader } from "@/components/shared/page-header";
import { ApiDocs } from "@/components/api-docs/api-docs";
import type { ApiCatalog } from "@/components/api-docs/types";

export const metadata = { title: "API Reference" };

/**
 * The GraphQL API reference + secure playground. Lives inside the dashboard
 * group (so it inherits auth + the app shell) and is linked from the API Tokens
 * settings panel. The catalog is introspected from the live schema on the
 * server; the playground runs against a sandboxed endpoint (read-only queries
 * execute, mutations are dry-run only — see `app/api/graphql/playground`).
 */
export default async function ApiDocsPage() {
  const [user, capabilities] = await Promise.all([
    requireUser(),
    currentCapabilities(),
  ]);

  // The server type is structurally identical to the client `ApiCatalog`.
  const catalog = buildApiCatalog() as ApiCatalog;

  return (
    <div className="space-y-6">
      <PageHeader
        title="API Reference"
        description="Every GraphQL query and mutation Deplo exposes, with a live, read-only playground. Authenticate external clients with an API token from Settings → API Tokens."
      />
      <ApiDocs
        catalog={catalog}
        capabilities={capabilities}
        isInstanceAdmin={user.isInstanceAdmin ?? false}
      />
    </div>
  );
}

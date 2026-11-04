import { titleClass } from "@/components/shared/page-header";

export function DeploymentsHeader() {
  return (
    <div className="space-y-1">
      <h1 className={titleClass.page}>Deployments</h1>
      <p className="text-sm text-muted-foreground">
        Every deployment across all of your apps and servers, newest first.
      </p>
    </div>
  );
}

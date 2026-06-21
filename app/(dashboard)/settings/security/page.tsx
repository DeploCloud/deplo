import { ShieldCheck, Lock, KeyRound } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Settings · Security" };

export default function SettingsSecurityPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Security" description="How Deplo protects your data." />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            Security posture
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <SecurityRow
            icon={<Lock className="size-4 text-[var(--success)]" />}
            title="Secrets encrypted at rest"
            detail="Env vars, DB connection strings and S3 keys are AES-256-GCM encrypted."
          />
          <SecurityRow
            icon={<KeyRound className="size-4 text-[var(--success)]" />}
            title="Session security"
            detail="HttpOnly, SameSite=Lax signed cookies. Sessions expire after 7 days."
          />
          <SecurityRow
            icon={<ShieldCheck className="size-4 text-[var(--success)]" />}
            title="Hardened headers + CSP"
            detail="Per-request nonce-based Content-Security-Policy and strict transport headers."
          />
          <p className="pt-2 text-xs text-muted-foreground">
            Set <code className="font-mono">DEPLO_SECRET</code> in production to
            rotate all derived encryption and signing keys.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function SecurityRow({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
      <div className="mt-0.5">{icon}</div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

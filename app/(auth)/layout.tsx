import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, isSetupNeeded } from "@/lib/auth";
import { DeploLogo } from "@/components/logo";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Real (signature-verifying) check  safe here, unlike the Edge proxy.
  const user = await getCurrentUser();
  if (user) redirect("/");
  // Fresh install with no account yet  send to the setup wizard.
  if (await isSetupNeeded()) redirect("/setup");

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <div className="relative z-10 w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Link href="/" className="cursor-pointer">
            <DeploLogo className="text-base" />
          </Link>
        </div>
        {children}
      </div>
      <p className="relative z-10 mt-8 text-center text-xs text-muted-foreground">
        Deplo self-hosted deployments with Docker &amp; Traefik
      </p>
    </div>
  );
}

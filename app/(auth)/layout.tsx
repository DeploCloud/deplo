import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, isSetupNeeded } from "@/lib/auth";
import { AuthChrome } from "@/components/auth/auth-chrome";
import { DeploLogo } from "@/components/logo";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Real (signature-verifying) check, safe here, unlike the Edge proxy.
  const user = await getCurrentUser();
  if (user) redirect("/");
  // Fresh install with no account yet: send to the setup wizard.
  if (await isSetupNeeded()) redirect("/setup");

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <AuthChrome />
      <div className="relative z-10 w-full max-w-sm">
        <div className="animate-soft-in mb-8 flex justify-center">
          <Link href="/" className="cursor-pointer">
            <DeploLogo className="text-3xl" />
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}

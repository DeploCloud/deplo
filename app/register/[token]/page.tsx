import Link from "next/link";
import { getRegistrationLinkInfo } from "@/lib/data/members";
import { DeploLogo } from "@/components/logo";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Register" };

export default async function RegisterPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const info = await getRegistrationLinkInfo(token);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Link href="/" className="cursor-pointer">
            <DeploLogo className="text-base" />
          </Link>
        </div>

        {info.valid ? (
          <RegisterForm
            token={token}
            mode={info.mode}
            teamNames={info.teamNames}
          />
        ) : (
          <div className="rounded-xl border border-border bg-card p-6 text-center">
            <h1 className="text-lg font-semibold">Link not valid</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This registration link has expired, been revoked, or already been
              used.
            </p>
            <Link
              href="/login"
              className="mt-4 inline-block text-sm text-foreground underline"
            >
              Go to sign in
            </Link>
          </div>
        )}
      </div>
      <p className="relative z-10 mt-8 text-center text-xs text-muted-foreground">
        Deplo — self-hosted deployments with Docker &amp; Traefik
      </p>
    </div>
  );
}

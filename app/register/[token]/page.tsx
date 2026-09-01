import Link from "next/link";
import { getRegistrationLinkInfo } from "@/lib/data/members";
import { AuthChrome } from "@/components/auth/auth-chrome";
import { Button } from "@/components/ui/button";
import { RegisterWizard } from "./register-wizard";

export const metadata = { title: "Register" };

export default async function RegisterPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const info = await getRegistrationLinkInfo(token);

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <div className="relative z-10 flex w-full justify-center">
        {info.valid ? (
          <RegisterWizard
            token={token}
            mode={info.mode}
            teamNames={info.teamNames}
          />
        ) : (
          // No intro in front of this one: a dead link should not cost two
          // seconds of animation before it says so. The chrome stays OUTSIDE the
          // animated box: its `filter` would become the containing block and
          // strand both fixed corners mid-screen.
          <>
            <AuthChrome />
            <div className="animate-soft-in w-full max-w-sm text-center">
              <h1 className="text-xl font-semibold sm:text-2xl">
                Link not valid
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                This registration link has expired, been revoked, or already
                been used.
              </p>
              <Button asChild variant="outline" className="mt-6 w-full">
                <Link href="/login">Go to sign in</Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

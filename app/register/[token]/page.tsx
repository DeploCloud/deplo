import Link from "@/components/ui/link";
import { getRegistrationLinkInfo } from "@/lib/data/members";
import { AuthChrome } from "@/components/auth/auth-chrome";
import { InvalidLinkGraphic } from "@/components/auth/invalid-link-graphic";
import { Button } from "@/components/ui/button";
import { RegisterWizard } from "./register-wizard";

export const metadata = { title: "Register" };

export default async function RegisterPage(
  props: PageProps<"/register/[token]">,
) {
  const { token } = await props.params;
  const info = await getRegistrationLinkInfo(token);
  const sp = await props.searchParams;

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      <div className="z-10 flex w-full justify-center">
        {info.valid ? (
          <RegisterWizard
            token={token}
            mode={info.mode}
            teams={info.teams}
            prefill={{ name: one(sp.name, 80), email: one(sp.email, 254) }}
          />
        ) : (
          // No intro in front of this one: a dead link should not cost two
          // seconds of animation before it says so. The chrome stays OUTSIDE the
          // animated box: its `filter` would become the containing block and
          // strand both fixed corners mid-screen.
          <>
            <AuthChrome />
            <div className="deplo-stagger w-full max-w-sm text-center">
              <InvalidLinkGraphic className="mx-auto mb-4" />
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                Link not valid
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                This registration link has expired, been revoked, or already
                been used. A link lasts 24 hours and works only once, so whoever
                invited you can send a fresh one.
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

/** A form default carried by the link (a migration fills these in), nothing the
 *  server acts on - capped at what the field itself takes. */
function one(v: string | string[] | undefined, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

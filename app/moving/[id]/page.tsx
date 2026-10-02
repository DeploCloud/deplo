import { notFound } from "next/navigation";

import { moveStatus } from "@/lib/data/deplo-move/target";
import { AuthChrome } from "@/components/auth/auth-chrome";
import { DeploLogo } from "@/components/logo";
import {
  MoveProgress,
  type MoveView,
} from "@/components/deplo-move/move-progress";

export const metadata = { title: "Moving Deplo" };

// Public on purpose: the id is unguessable, and the copy signs everyone out (ADR-0035).
export default async function MovingPage(props: PageProps<"/moving/[id]">) {
  const { id } = await props.params;
  const status = await moveStatus(id);
  if (!status) notFound();
  const view: MoveView & { startedBy?: string } = { ...status };
  delete view.startedBy;

  return (
    <div className="relative flex min-h-dvh flex-col">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      <AuthChrome />
      <header className="relative z-10 px-6 py-5">
        <DeploLogo />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pt-8 pb-16">
        <div className="w-full max-w-xl">
          <MoveProgress initial={view} />
        </div>
      </main>
    </div>
  );
}

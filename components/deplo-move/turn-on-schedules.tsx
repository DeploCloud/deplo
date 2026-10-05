"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";

const RESUME_MOVE_SCHEDULES = /* GraphQL */ `
  mutation ResumeMoveSchedules {
    resumeMoveSchedules
  }
`;

export function TurnOnSchedules() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await gqlAction(RESUME_MOVE_SCHEDULES);
          if (!res.ok) toast.error(res.error);
          else router.refresh();
        })
      }
      className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:no-underline disabled:opacity-60"
    >
      {pending && <Loader2 className="size-3 animate-spin" />}
      Turn on
    </button>
  );
}

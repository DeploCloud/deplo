import type { CronRunStatus } from "../types/cron";

export interface CronRunStatusMeta {
  variant: "success" | "destructive" | "warning" | "muted";
  label: string;
  note?: string;
}

/** How each run status reads, in the job list and in a run's history. */
export const CRON_RUN_STATUS: Record<CronRunStatus, CronRunStatusMeta> = {
  running: { variant: "warning", label: "Running" },
  succeeded: { variant: "success", label: "Succeeded" },
  failed: { variant: "destructive", label: "Failed" },
  timedout: {
    variant: "destructive",
    label: "Timed out",
    note: "Stopped at the job's timeout. Raise it under Advanced if the command legitimately takes this long.",
  },
  skipped: {
    variant: "muted",
    label: "Skipped",
    note: "This run never started, so nothing failed.",
  },
  lost: {
    variant: "warning",
    label: "Unknown",
    note: "Deplo lost track of this run when the server's agent restarted. The command may or may not have completed.",
  },
  server_lost: {
    variant: "warning",
    label: "Lost: its server stopped",
    note: "The command may be half done. Deplo never runs a lost run again on its own: use Run now if it is safe to repeat.",
  },
};

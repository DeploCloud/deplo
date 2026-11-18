// A single-writer stack on a cluster whose agents start it under its lease renders restart policy "no", and this
// label says what policy it stands for: the agent restarts it as that policy would, and gives it back off the cluster.
export const RESTART_LABEL = "deplo.restart";

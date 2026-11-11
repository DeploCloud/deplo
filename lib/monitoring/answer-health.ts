// The server agent's own check result, so "healthy" here is what the restart rule acts on.
// No result (no rule, switch off, older agent) leaves Docker's verdict: never a made-up "healthy".
const ANSWER_HEALTH: Record<string, string> = {
  answering: "healthy",
  not_answering: "unhealthy",
  starting: "starting",
};

export function healthOf(i: { health: string; answer?: string }): string {
  const seen = ANSWER_HEALTH[i.answer ?? ""];
  if (!seen || i.health === "unhealthy") return i.health;
  return seen;
}

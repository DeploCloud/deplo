import { runWithIdentity } from "../lib/auth/request-context";
import { redeploy } from "../lib/data/deployments";

const d = await runWithIdentity(
  { userId: "usr_2f9f8b8ebf3b1131", teamId: "team_8d691fadd5f3d547" },
  () => redeploy("prj_af37ac7cbc3bd939"),
);
console.log("DEPLOYMENT", d.id);
process.exit(0);

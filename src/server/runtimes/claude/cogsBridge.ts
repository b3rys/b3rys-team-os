import { runBridge } from "../codex/bridge";
import { runClaudeCogsTurn } from "./cogsRunner";
import { channelFromEnv } from "../../lib/memberChannel";

if (import.meta.main) {
  const channel=channelFromEnv();
  if (channel.kind !== "b3chat") throw new Error("Claude app bridge requires b3chat channel");
  void runBridge({channel,runTurn:runClaudeCogsTurn});
}

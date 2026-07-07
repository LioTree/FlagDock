import { resetChallenge, startChallenge } from "./commands/challenge.js";
import { watchFlags } from "./commands/flags.js";
import { showChallenges, showStatus, startManager, stopManager } from "./commands/manager.js";
import { attach, newSession, setMode, showSessions } from "./commands/session.js";
import { workspaceAction, workspaceAllAction, workspaceSolvedAction } from "./commands/workspace.js";
import { isAllScope, isSolvedScope, usage } from "./support.js";

export async function runCli(args) {
  const [command, subcommand, ...rest] = args;
  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command === "start") {
    await startManager();
    return;
  }
  if (command === "stop") {
    await stopManager();
    return;
  }
  if (command === "status") {
    await showStatus();
    return;
  }
  if (command === "challenges") {
    await showChallenges();
    return;
  }
  if (command === "flags" && subcommand === "watch") {
    await watchFlags(rest);
    return;
  }
  if (command === "challenge" && subcommand === "start") {
    await startChallenge(rest);
    return;
  }
  if (command === "challenge" && subcommand === "reset") {
    await resetChallenge(rest);
    return;
  }
  if (command === "sessions") {
    await showSessions([subcommand, ...rest].filter(Boolean));
    return;
  }
  if (command === "attach") {
    await attach([subcommand, ...rest].filter(Boolean));
    return;
  }
  if (command === "session" && subcommand === "new") {
    await newSession(rest);
    return;
  }
  if (command === "mode" && subcommand === "set") {
    await setMode(rest);
    return;
  }
  if (command === "workspace" && subcommand === "stop" && isAllScope(rest)) {
    await workspaceAllAction("stop");
    return;
  }
  if (command === "workspace" && subcommand === "clear" && isAllScope(rest)) {
    await workspaceAllAction("clear");
    return;
  }
  if (command === "workspace" && subcommand === "stop" && isSolvedScope(rest)) {
    await workspaceSolvedAction("stop");
    return;
  }
  if (command === "workspace" && subcommand === "clear" && isSolvedScope(rest)) {
    await workspaceSolvedAction("clear");
    return;
  }
  if (command === "workspace" && subcommand === "stop") {
    await workspaceAction(rest, "stop");
    return;
  }
  if (command === "workspace" && subcommand === "clear") {
    await workspaceAction(rest, "clear");
    return;
  }
  throw new Error(usage());
}

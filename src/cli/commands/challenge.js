import { request } from "../request.js";
import { hasFlag, parseOption, positionalArgs, printTable, truncate, usage } from "../support.js";

export async function startChallenge(args) {
  if (args.includes("--force")) {
    throw new Error("`--force` is not supported for challenge start");
  }
  const positions = positionalArgs(args, ["--mode"]);
  const mode = parseOption(args, "--mode") ?? "auto";
  if (hasFlag(args, "--all")) {
    if (positions.length > 0) {
      throw new Error(usage());
    }
    const result = await request("POST", "/challenge/start-all", { mode });
    printTable(result.challenges ?? [], [
      { header: "challenge", value: (row) => row.challenge },
      { header: "status", value: (row) => row.status ?? "" },
      { header: "result", value: (row) => row.result ?? "" },
      { header: "detail", value: (row) => row.detail ?? truncate(row.error ?? "", 56) },
    ]);
    console.log(`started: ${result.started ?? 0} skipped: ${result.skipped ?? 0} failed: ${result.failed ?? 0} total: ${result.count ?? 0}`);
    return;
  }
  if (positions.length !== 1) {
    throw new Error(usage());
  }
  const [challenge] = positions;
  const result = await request("POST", "/challenge/start", { challenge, mode });
  if (result.skipped) {
    console.log(`challenge ${result.challenge} already has a backend solution; auto start skipped`);
    console.log("use --mode manual to start a workspace for inspection");
    return;
  }
  console.log(`workspace: ${result.workspace.status} backends=${(result.workspace.backends ?? []).join(",")}`);
  if (result.workspace.server_url) {
    console.log(`opencode server: ${result.workspace.server_url}`);
  }
  if (result.workspace.codex_server_url) {
    console.log(`codex server: ${result.workspace.codex_server_url}`);
  }
  if (result.workspace.attach_server_url && result.workspace.attach_server_url !== result.workspace.server_url) {
    console.log(`attach base: ${result.workspace.attach_server_url}`);
  }
  if (result.primary_session) {
    console.log(`primary session: ${result.primary_session.session_id} mode=${result.primary_session.mode}`);
  }
  if (result.opencode_primary_session && result.opencode_primary_session !== result.primary_session) {
    console.log(`opencode session: ${result.opencode_primary_session.session_id} mode=${result.opencode_primary_session.mode}`);
  }
  if (result.codex_primary_session) {
    console.log(`codex session: ${result.codex_primary_session.session_id} mode=${result.codex_primary_session.mode}`);
  }
}

export async function resetChallenge(args) {
  const positions = positionalArgs(args);
  if (hasFlag(args, "--all")) {
    if (positions.length > 0) {
      throw new Error(usage());
    }
    const result = await request("POST", "/challenge/reset-all");
    printTable(result.challenges ?? [], [
      { header: "challenge", value: (row) => row.challenge },
      { header: "status", value: (row) => row.status ?? "" },
      { header: "result", value: (row) => row.result ?? "" },
      { header: "detail", value: (row) => row.detail ?? truncate(row.error ?? "", 56) },
    ]);
    console.log(`reset: ${result.reset ?? 0} unchanged: ${result.unchanged ?? 0} skipped: ${result.skipped ?? 0} failed: ${result.failed ?? 0} total: ${result.count ?? 0}`);
    return;
  }
  if (positions.length !== 1) {
    throw new Error(usage());
  }
  const [challenge] = positions;
  const result = await request("POST", "/challenge/reset", { challenge });
  console.log(JSON.stringify(result, null, 2));
}

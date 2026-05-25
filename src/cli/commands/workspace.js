import { request } from "../request.js";
import { printTable, truncate, usage } from "../support.js";

export async function workspaceAction(args, action) {
  const challenge = args[0];
  if (!challenge || args.length !== 1 || args.includes("--all") || args.includes("--solved")) {
    throw new Error(usage());
  }
  const pathname = action === "clear" ? "/workspace/clear" : `/workspace/${action}`;
  const result = await request("POST", pathname, { challenge });
  console.log(JSON.stringify(result, null, 2));
}

export async function workspaceAllAction(action) {
  const pathname = action === "clear" ? "/workspace/clear-all" : "/workspace/stop-all";
  const result = await request("POST", pathname);
  printTable(result.workspaces ?? [], [
    { header: "challenge", value: (row) => row.challenge },
    { header: "status", value: (row) => row.status ?? "" },
    { header: "container", value: (row) => row.container ?? "" },
    { header: "changed", value: (row) => row.stopped ?? row.removed ?? false },
  ]);
  if (typeof result.count === "number") {
    console.log(`total: ${result.count}`);
  }
}

export async function workspaceSolvedAction(action) {
  const pathname = action === "clear" ? "/workspace/clear-solved" : "/workspace/stop-solved";
  const result = await request("POST", pathname);
  printTable(result.workspaces ?? [], [
    { header: "challenge", value: (row) => row.challenge },
    { header: "status", value: (row) => row.status ?? "" },
    { header: "solved_by", value: (row) => row.solved_by ?? "" },
    { header: "container", value: (row) => row.container ?? "" },
    { header: "changed", value: (row) => row.changed ?? false },
    { header: "result", value: (row) => row.result ?? "" },
    { header: "detail", value: (row) => truncate(row.detail ?? row.error ?? "", 56) },
  ]);
  const changedKey = action === "clear" ? "cleared" : "stopped";
  console.log(`${changedKey}: ${result[changedKey] ?? 0} unchanged: ${result.unchanged ?? 0} failed: ${result.failed ?? 0} total: ${result.count ?? 0}`);
}

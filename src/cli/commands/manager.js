import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MANAGER_HOST, ROOT_DIR, STATE_DIR } from "../../constants.js";
import { scanChallenges } from "../../challenges.js";
import { loadFlagDockConfig } from "../../config.js";
import { loadState } from "../../state.js";
import { ensureDir, sleep } from "../../util.js";
import { managerInfo, request } from "../request.js";
import { printTable } from "../support.js";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_ENTRY = path.join(CLI_DIR, "..", "..", "manager", "index.js");

export async function startManager() {
  const existing = await managerInfo();
  if (existing) {
    console.log(`manager already running at http://${existing.host ?? DEFAULT_MANAGER_HOST}:${existing.port}`);
    return;
  }
  await ensureDir(STATE_DIR);
  const out = await fs.open(path.join(STATE_DIR, "manager.out.log"), "a");
  const err = await fs.open(path.join(STATE_DIR, "manager.err.log"), "a");
  const child = spawn(process.execPath, [MANAGER_ENTRY], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: ["ignore", out.fd, err.fd],
    env: process.env,
  });
  child.unref();
  await out.close();
  await err.close();

  for (let i = 0; i < 40; i += 1) {
    const info = await managerInfo();
    if (info) {
      console.log(`manager started at http://${info.host ?? DEFAULT_MANAGER_HOST}:${info.port}`);
      return;
    }
    await sleep(250);
  }
  throw new Error("manager did not become healthy; check .flagdock/manager.log and .flagdock/manager.err.log");
}

export async function stopManager() {
  const info = await managerInfo();
  if (!info) {
    console.log("manager is not running");
    return;
  }
  await request("POST", "/stop");
  console.log("manager stopped");
}

export async function showStatus() {
  const info = await managerInfo();
  if (!info) {
    console.log("manager: stopped");
    return;
  }
  const status = await request("GET", "/status");
  console.log(`manager: running pid=${status.pid} url=http://${info.host ?? DEFAULT_MANAGER_HOST}:${info.port}`);
  printTable(status.workspaces, [
    { header: "challenge", value: (row) => row.challenge },
    { header: "status", value: (row) => row.status },
    { header: "backends", value: (row) => (row.backends ?? []).join(",") },
    { header: "sessions", value: (row) => row.sessions },
    { header: "primary", value: (row) => row.primary_session },
    { header: "codex_primary", value: (row) => row.codex_primary_session },
    { header: "solved_by", value: (row) => row.solved_by },
    { header: "server", value: (row) => row.server_url },
    { header: "attach", value: (row) => row.attach_server_url },
  ]);
}

export async function showChallenges() {
  const info = await managerInfo();
  let challenges;
  if (info) {
    ({ challenges } = await request("GET", "/challenges"));
  } else {
    const state = await loadState();
    const config = await loadFlagDockConfig();
    challenges = await scanChallenges(config.workspace.challengesDir, state.workspaces);
  }
  printTable(challenges, [
    { header: "challenge", value: (row) => row.challenge },
    { header: "status", value: (row) => row.status },
    { header: "backends", value: (row) => row.backends ?? "" },
    { header: "sessions", value: (row) => row.sessions },
    { header: "primary", value: (row) => row.primary_session },
    { header: "solved_by", value: (row) => row.solved_by ?? "" },
  ]);
}

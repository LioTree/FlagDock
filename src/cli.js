import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_PATH, DEFAULT_MANAGER_HOST, ROOT_DIR, STATE_DIR } from "./constants.js";
import { scanChallenges } from "./challenges.js";
import { loadFlagDockConfig } from "./config.js";
import { loadDaemonInfo, loadState } from "./state.js";
import { ensureDir, formatTimestamp, sleep } from "./util.js";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_ENTRY = path.join(CLI_DIR, "manager.js");

function usage() {
  return `Usage:
  flagdock start
  flagdock stop
  flagdock status
  flagdock challenges
  flagdock challenge start <challenge> [--mode auto|manual]
  flagdock challenge reset <challenge>
  flagdock sessions <challenge> [--backend opencode|codex]
  flagdock attach <challenge> [--backend opencode|codex] [--session <session_id>]
  flagdock session new <challenge> [--backend opencode|codex] [--mode auto|manual]
  flagdock mode set <challenge> [--backend opencode|codex] --session <session_id> auto|manual
  flagdock workspace stop <challenge>
  flagdock workspace rm <challenge>
  flagdock workspace stop-all
  flagdock workspace rm-all`;
}

function parseOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

function lastArg(args) {
  return args[args.length - 1];
}

async function ping(info) {
  if (!info?.port) {
    return false;
  }
  try {
    const response = await fetch(`http://${info.host ?? DEFAULT_MANAGER_HOST}:${info.port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function managerInfo() {
  const info = await loadDaemonInfo();
  if (await ping(info)) {
    return info;
  }
  return null;
}

async function request(method, pathname, body) {
  const info = await managerInfo();
  if (!info) {
    throw new Error("manager is not running; run `flagdock start` first");
  }
  const url = `http://${info.host ?? DEFAULT_MANAGER_HOST}:${info.port}${pathname}`;
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `${method} ${pathname} failed with ${response.status}`);
  }
  return payload;
}

function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const widths = columns.map((column) => Math.max(
    column.header.length,
    ...rows.map((row) => String(column.value(row) ?? "").length),
  ));
  console.log(columns.map((column, index) => column.header.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => String(column.value(row) ?? "").padEnd(widths[index])).join("  "));
  }
}

function truncate(value, max = 64) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function startManager() {
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

async function stopManager() {
  const info = await managerInfo();
  if (!info) {
    console.log("manager is not running");
    return;
  }
  await request("POST", "/stop");
  console.log("manager stopped");
}

async function showStatus() {
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

async function showChallenges() {
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

async function startChallenge(args) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  if (args.includes("--force")) {
    throw new Error("`--force` is not supported for challenge start");
  }
  const mode = parseOption(args, "--mode") ?? "auto";
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

async function resetChallenge(args) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  const result = await request("POST", "/challenge/reset", { challenge });
  console.log(JSON.stringify(result, null, 2));
}

async function showSessions(args) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  const backend = parseOption(args, "--backend");
  const query = new URLSearchParams({ challenge });
  if (backend) {
    query.set("backend", backend);
  }
  const { sessions } = await request("GET", `/sessions?${query}`);
  printTable(sessions, [
    { header: "backend", value: (row) => row.backend ?? "opencode" },
    { header: "session", value: (row) => row.session_id },
    { header: "role", value: (row) => row.role },
    { header: "source", value: (row) => row.source },
    { header: "mode", value: (row) => row.mode },
    { header: "status", value: (row) => row.status },
    { header: "error", value: (row) => truncate(row.last_error, 56) },
    { header: "created", value: (row) => formatTimestamp(row.created_at) },
  ]);
}

async function attach(args) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  const backend = parseOption(args, "--backend");
  const session = parseOption(args, "--session");
  const query = new URLSearchParams({ challenge });
  if (backend) {
    query.set("backend", backend);
  }
  if (session) {
    query.set("session", session);
  }
  const result = await request("GET", `/attach?${query}`);
  console.log(result.command ?? result.url);
}

async function newSession(args) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  const backend = parseOption(args, "--backend");
  const mode = parseOption(args, "--mode") ?? "auto";
  const { session } = await request("POST", "/session/new", { challenge, mode, backend });
  console.log(`${session.session_id} mode=${session.mode} url=${session.url}`);
}

async function setMode(args) {
  const challenge = args[0];
  const session = parseOption(args, "--session");
  const backend = parseOption(args, "--backend") ?? "opencode";
  const mode = lastArg(args);
  if (!challenge || !session || !mode || mode === session) {
    throw new Error(usage());
  }
  const result = await request("POST", "/mode/set", { challenge, session, mode, backend });
  console.log(`${result.session.session_id} mode=${result.session.mode}`);
}

async function workspaceAction(args, action) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  const result = await request("POST", `/workspace/${action}`, { challenge });
  console.log(JSON.stringify(result, null, 2));
}

async function workspaceAllAction(action) {
  const result = await request("POST", `/workspace/${action}`);
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
  if (command === "workspace" && (subcommand === "stop" || subcommand === "rm")) {
    await workspaceAction(rest, subcommand);
    return;
  }
  if (command === "workspace" && (subcommand === "stop-all" || subcommand === "rm-all")) {
    await workspaceAllAction(subcommand);
    return;
  }
  throw new Error(usage());
}

import http from "node:http";
import { URL } from "node:url";
import {
  AGENT_NAME,
  CONTAINER_CHALLENGE_DIR,
  DEFAULT_MANAGER_HOST,
  LOG_PATH,
} from "./constants.js";
import { getChallengeInfo, scanChallenges } from "./challenges.js";
import { buildWorkspaceUrls, loadFlagDockConfig } from "./config.js";
import {
  containerHostPort,
  containerStatus,
  ensureImages,
  inspectContainer,
  removeWorkspaceContainer,
  startWorkspaceContainer,
  stopWorkspaceContainer,
  workspaceContainerName,
} from "./docker.js";
import { createAttachedRuntime, defaultSessionOptions, requireData, waitForOpenCode } from "./opencode.js";
import { ensureAgentFile, readSessionPrompt } from "./prompts.js";
import { loadState, saveDaemonInfo, saveState } from "./state.js";
import { appendText, attachDirectorySegment, nowIso, sleep } from "./util.js";

const DEFAULT_MODE = "auto";
const VALID_MODES = new Set(["auto", "manual"]);
const AUTO_ERROR_BACKOFF_MS = [15000, 30000, 60000, 120000, 300000];

function validateMode(mode, fallback = DEFAULT_MODE) {
  const selected = mode ?? fallback;
  if (!VALID_MODES.has(selected)) {
    throw new Error(`Invalid mode: ${selected}`);
  }
  return selected;
}

function normalizeSessionStatus(openCodeStatus, info, solved) {
  if (info?.time?.archived) {
    return "closed";
  }
  if (openCodeStatus?.type === "busy" || openCodeStatus?.type === "retry") {
    return "active";
  }
  if (solved && openCodeStatus?.type === "idle") {
    return "completed";
  }
  if (openCodeStatus?.type === "idle") {
    return "idle";
  }
  if (info) {
    return solved ? "completed" : "idle";
  }
  return "unknown";
}

function sessionUrl(baseUrl, sessionID) {
  return `${baseUrl}/${attachDirectorySegment(CONTAINER_CHALLENGE_DIR)}/session/${sessionID}`;
}

function messageErrorSummary(message) {
  const error = message?.info?.error;
  if (!error) {
    return "";
  }
  const name = error.name ?? "Error";
  const detail = error.data?.message ?? error.message ?? JSON.stringify(error);
  return `${name}: ${detail}`;
}

function errorSummary(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error) ?? String(error);
}

export class FlagDockManager {
  constructor() {
    this.state = null;
    this.startedAt = nowIso();
    this.server = null;
    this.runtimes = new Map();
    this.activeAutoLoops = new Map();
    this.tickTimer = null;
    this.stopping = false;
  }

  async log(message) {
    await appendText(LOG_PATH, `[${nowIso()}] ${message}\n`).catch(() => {});
  }

  async load() {
    this.state = await loadState();
  }

  async save() {
    await saveState(this.state);
  }

  async listen(port = 0) {
    await this.load();
    await ensureAgentFile();

    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, DEFAULT_MANAGER_HOST, resolve);
    });

    const address = this.server.address();
    await saveDaemonInfo({
      pid: process.pid,
      host: DEFAULT_MANAGER_HOST,
      port: address.port,
      started_at: this.startedAt,
    });
    await this.log(`manager listening on ${DEFAULT_MANAGER_HOST}:${address.port}`);
    this.startTicks();
  }

  startTicks() {
    this.tickTimer = setInterval(() => {
      this.tick().catch((error) => this.log(`tick failed: ${error.message}`));
    }, 30000);
    this.tick().catch((error) => this.log(`initial tick failed: ${error.message}`));
  }

  async close() {
    this.stopping = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    for (const runtime of this.runtimes.values()) {
      await runtime.dispose().catch(() => {});
    }
    await this.save();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }

  async readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) {
      return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  writeJson(response, statusCode, value) {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  async handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      this.writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/status") {
      this.writeJson(response, 200, await this.status());
      return;
    }
    if (request.method === "GET" && url.pathname === "/challenges") {
      await this.refreshWorkspaceContainerStates();
      this.writeJson(response, 200, { challenges: await scanChallenges(this.state.workspaces) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/start") {
      this.writeJson(response, 200, await this.startChallenge(await this.readBody(request)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
      this.writeJson(response, 200, { sessions: await this.listSessions(url.searchParams.get("challenge")) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/attach") {
      this.writeJson(response, 200, await this.attach(url.searchParams.get("challenge"), url.searchParams.get("session")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/new") {
      this.writeJson(response, 200, await this.newSession(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/mode/set") {
      this.writeJson(response, 200, await this.setMode(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop") {
      this.writeJson(response, 200, await this.stopWorkspace(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/rm") {
      this.writeJson(response, 200, await this.removeWorkspace(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop-all") {
      this.writeJson(response, 200, await this.stopAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/rm-all") {
      this.writeJson(response, 200, await this.removeAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      this.writeJson(response, 200, { ok: true });
      setTimeout(() => this.close().then(() => process.exit(0)), 20);
      return;
    }
    this.writeJson(response, 404, { error: "not found" });
  }

  async status() {
    await this.refreshWorkspaceContainerStates();
    return {
      ok: true,
      pid: process.pid,
      started_at: this.startedAt,
      workspaces: Object.values(this.state.workspaces).map((workspace) => ({
        challenge: workspace.challenge,
        status: workspace.status,
        server_url: workspace.serverUrl ?? "",
        attach_server_url: workspace.attachServerUrl ?? workspace.serverUrl ?? "",
        primary_session: workspace.primarySessionId ?? "",
        sessions: Object.keys(workspace.sessions ?? {}).length,
      })),
    };
  }

  async refreshWorkspaceContainerState(workspace, config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    const inspected = await inspectContainer(workspace.containerName ?? workspaceContainerName(workspace.challenge));
    const status = containerStatus(inspected);
    if (status) {
      workspace.status = status;
      const hostPort = containerHostPort(inspected);
      if (hostPort) {
        const urls = buildWorkspaceUrls(resolvedConfig, hostPort);
        workspace.hostPort = hostPort;
        workspace.serverUrl = urls.serverUrl;
        workspace.attachServerUrl = urls.attachServerUrl;
      }
    }
  }

  async refreshWorkspaceContainerStates() {
    const config = await loadFlagDockConfig();
    for (const workspace of Object.values(this.state.workspaces)) {
      await this.refreshWorkspaceContainerState(workspace, config);
    }
    await this.save();
  }

  getWorkspace(challenge) {
    const existing = this.state.workspaces[challenge];
    if (existing) {
      existing.sessions ??= {};
      return existing;
    }
    const workspace = {
      challenge,
      status: "available",
      sessions: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.state.workspaces[challenge] = workspace;
    return workspace;
  }

  async ensureWorkspace(challenge) {
    const info = await getChallengeInfo(challenge);
    if (!info.valid) {
      throw new Error(`Challenge ${challenge} is invalid or missing challenge.md`);
    }
    await ensureAgentFile();
    await ensureImages((message) => this.log(message));
    const config = await loadFlagDockConfig();
    const workspace = this.getWorkspace(challenge);
    const container = await startWorkspaceContainer({
      bindHost: config.workspace.bindHost,
      challenge,
      challengeDir: info.dir,
      log: (message) => this.log(message),
    });
    const urls = buildWorkspaceUrls(config, container.hostPort);
    Object.assign(workspace, container, {
      ...urls,
      challenge,
      challengeDir: info.dir,
      updatedAt: nowIso(),
    });
    await this.save();
    await this.getRuntime(workspace);
    return workspace;
  }

  async getRuntime(workspace) {
    if (!workspace.serverUrl) {
      throw new Error(`Workspace ${workspace.challenge} has no server URL`);
    }
    const cached = this.runtimes.get(workspace.serverUrl);
    if (cached) {
      return cached;
    }
    const runtime = await waitForOpenCode(() => createAttachedRuntime(workspace.serverUrl));
    this.runtimes.set(workspace.serverUrl, runtime);
    return runtime;
  }

  async syncSessions(workspace) {
    if (workspace.status !== "running") {
      return Object.values(workspace.sessions ?? {});
    }
    const runtime = await this.getRuntime(workspace);
    const [sessions, statuses] = await Promise.all([
      requireData("session.list", runtime.client.session.list({
        directory: CONTAINER_CHALLENGE_DIR,
        limit: 200,
      })),
      requireData("session.status", runtime.client.session.status({
        directory: CONTAINER_CHALLENGE_DIR,
      })).catch(() => ({})),
    ]);
    const solved = (await getChallengeInfo(workspace.challenge)).solved;
    for (const session of sessions) {
      const existing = workspace.sessions[session.id] ?? {};
      const registry = {
        session_id: session.id,
        challenge: workspace.challenge,
        directory: CONTAINER_CHALLENGE_DIR,
        role: session.id === workspace.primarySessionId ? "primary" : (existing.role ?? "auxiliary"),
        source: existing.source ?? "discovered",
        mode: existing.mode ?? "manual",
        created_at: existing.created_at ?? new Date(session.time.created).toISOString(),
        last_seen_at: nowIso(),
        status: normalizeSessionStatus(statuses[session.id], session, solved),
        url: sessionUrl(workspace.attachServerUrl ?? workspace.serverUrl, session.id),
        title: session.title ?? "",
        last_auto_prompt_at: existing.last_auto_prompt_at,
        last_auto_prompt_kind: existing.last_auto_prompt_kind,
        last_response_at: existing.last_response_at,
        writeup_prompt_sent_at: existing.writeup_prompt_sent_at,
        last_error: existing.last_error ?? "",
      };
      try {
        const messages = await requireData("session.messages", runtime.client.session.messages({
          sessionID: session.id,
          directory: CONTAINER_CHALLENGE_DIR,
          limit: 10,
        }));
        const latestError = [...messages].reverse().map(messageErrorSummary).find(Boolean);
        registry.last_error = latestError ?? "";
      } catch {
        registry.last_error = existing.last_error ?? "";
      }
      workspace.sessions[session.id] = registry;
    }
    for (const session of Object.values(workspace.sessions)) {
      if (!sessions.some((item) => item.id === session.session_id) && session.status !== "closed") {
        session.status = "unknown";
      }
    }
    await this.save();
    return Object.values(workspace.sessions);
  }

  async startChallenge({ challenge, mode, force }) {
    if (force) {
      throw new Error("force start is not supported");
    }
    const selectedMode = validateMode(mode);
    const info = await getChallengeInfo(challenge);
    if (!info.valid) {
      throw new Error(`Challenge ${challenge} is invalid or missing challenge.md`);
    }
    if (selectedMode === "auto" && info.solved) {
      return {
        skipped: true,
        reason: "solved",
        challenge,
        flag_path: info.flagPath,
      };
    }
    const workspace = await this.ensureWorkspace(challenge);
    await this.syncSessions(workspace);
    let primary = workspace.primarySessionId ? workspace.sessions[workspace.primarySessionId] : null;
    if (!primary) {
      const runtime = await this.getRuntime(workspace);
      const session = await runtime.createSession(defaultSessionOptions());
      workspace.primarySessionId = session.id;
      primary = this.registerManagedSession(workspace, session.id, {
        role: "primary",
        mode: selectedMode,
      });
    } else {
      primary.mode = selectedMode;
    }
    await this.save();
    if (selectedMode === "auto") {
      this.driveSession(workspace.challenge, primary.session_id, "initial").catch((error) => this.log(`drive failed: ${error.message}`));
    }
    return {
      workspace: this.workspaceSummary(workspace),
      primary_session: primary,
    };
  }

  registerManagedSession(workspace, sessionID, { role, mode }) {
    const existing = workspace.sessions[sessionID] ?? {};
    const registry = {
      session_id: sessionID,
      challenge: workspace.challenge,
      directory: CONTAINER_CHALLENGE_DIR,
      role,
      source: "managed",
      mode,
      created_at: existing.created_at ?? nowIso(),
      last_seen_at: nowIso(),
      status: existing.status ?? "unknown",
      url: sessionUrl(workspace.attachServerUrl ?? workspace.serverUrl, sessionID),
      title: existing.title ?? "",
      last_auto_prompt_at: existing.last_auto_prompt_at,
      last_auto_prompt_kind: existing.last_auto_prompt_kind,
      last_response_at: existing.last_response_at,
      writeup_prompt_sent_at: existing.writeup_prompt_sent_at,
      last_error: existing.last_error ?? "",
    };
    workspace.sessions[sessionID] = registry;
    return registry;
  }

  workspaceSummary(workspace) {
    return {
      challenge: workspace.challenge,
      status: workspace.status,
      container: workspace.containerName,
      server_url: workspace.serverUrl,
      attach_server_url: workspace.attachServerUrl ?? workspace.serverUrl,
      primary_session: workspace.primarySessionId ?? "",
      sessions: Object.keys(workspace.sessions ?? {}).length,
    };
  }

  async listSessions(challenge) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const workspace = this.state.workspaces[challenge];
    if (!workspace) {
      return [];
    }
    await this.refreshWorkspaceContainerState(workspace);
    await this.syncSessions(workspace);
    return Object.values(workspace.sessions).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async attach(challenge, sessionID) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const workspace = this.state.workspaces[challenge];
    if (!workspace) {
      throw new Error(`Workspace ${challenge} is not running`);
    }
    await this.refreshWorkspaceContainerState(workspace);
    if (workspace.status !== "running") {
      throw new Error(`Workspace ${challenge} is not running`);
    }
    await this.syncSessions(workspace);
    const selected = sessionID || workspace.primarySessionId;
    if (!selected || !workspace.sessions[selected]) {
      throw new Error(`Session not found for ${challenge}`);
    }
    return {
      challenge,
      session: selected,
      url: workspace.sessions[selected].url,
    };
  }

  async newSession({ challenge, mode }) {
    const selectedMode = validateMode(mode, "auto");
    const workspace = await this.ensureWorkspace(challenge);
    const runtime = await this.getRuntime(workspace);
    const session = await runtime.createSession(defaultSessionOptions());
    const registry = this.registerManagedSession(workspace, session.id, {
      role: "auxiliary",
      mode: selectedMode,
    });
    await this.save();
    if (selectedMode === "auto") {
      this.driveSession(workspace.challenge, registry.session_id, "initial").catch((error) => this.log(`drive failed: ${error.message}`));
    }
    return { session: registry };
  }

  async setMode({ challenge, session, mode }) {
    const selectedMode = validateMode(mode);
    const workspace = this.state.workspaces[challenge];
    if (!workspace) {
      throw new Error(`Workspace ${challenge} does not exist`);
    }
    await this.syncSessions(workspace);
    const registry = workspace.sessions[session];
    if (!registry) {
      throw new Error(`Session ${session} not found`);
    }
    registry.mode = selectedMode;
    await this.save();
    if (selectedMode === "auto") {
      const kind = registry.last_auto_prompt_at ? "continue" : "initial";
      this.driveSession(workspace.challenge, registry.session_id, kind).catch((error) => this.log(`drive failed: ${error.message}`));
    }
    return { session: registry };
  }

  async stopWorkspace({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const stopped = await stopWorkspaceContainer(challenge);
    const workspace = this.state.workspaces[challenge] ?? this.getWorkspace(challenge);
    workspace.status = "stopped";
    workspace.updatedAt = nowIso();
    if (workspace.serverUrl) {
      const runtime = this.runtimes.get(workspace.serverUrl);
      await runtime?.dispose().catch(() => {});
      this.runtimes.delete(workspace.serverUrl);
    }
    await this.save();
    return { stopped, workspace: this.workspaceSummary(workspace) };
  }

  async removeWorkspace({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const removed = await removeWorkspaceContainer(challenge);
    const workspace = this.state.workspaces[challenge];
    if (workspace?.serverUrl) {
      const runtime = this.runtimes.get(workspace.serverUrl);
      await runtime?.dispose().catch(() => {});
      this.runtimes.delete(workspace.serverUrl);
    }
    delete this.state.workspaces[challenge];
    await this.save();
    return { removed };
  }

  async stopAllWorkspaces() {
    const results = [];
    for (const challenge of Object.keys(this.state.workspaces).sort()) {
      const result = await this.stopWorkspace({ challenge });
      results.push({
        challenge,
        stopped: result.stopped,
        status: result.workspace.status,
        container: result.workspace.container,
      });
    }
    return {
      count: results.length,
      workspaces: results,
    };
  }

  async removeAllWorkspaces() {
    const results = [];
    for (const challenge of Object.keys(this.state.workspaces).sort()) {
      const result = await this.removeWorkspace({ challenge });
      results.push({
        challenge,
        removed: result.removed,
      });
    }
    return {
      count: results.length,
      workspaces: results,
    };
  }

  promptKind(kind) {
    if (kind === "initial" || kind === "writeup") {
      return kind;
    }
    return "continue";
  }

  updateSessionRegistry(workspace, sessionID, values) {
    const registry = workspace.sessions[sessionID];
    if (!registry) {
      return null;
    }
    Object.assign(registry, values);
    return registry;
  }

  async driveSession(challenge, sessionID, kind = "continue") {
    const key = `${challenge}:${sessionID}`;
    if (this.activeAutoLoops.has(key) || this.stopping) {
      return;
    }
    const task = this.runAutoSessionLoop(challenge, sessionID, kind)
      .catch((error) => this.log(`session ${sessionID} auto loop failed: ${error.message}`))
      .finally(() => this.activeAutoLoops.delete(key));
    this.activeAutoLoops.set(key, task);
  }

  async sendAutoPromptTurn(workspace, sessionID, kind) {
    const runtime = await this.getRuntime(workspace);
    const session = await runtime.openSession(sessionID, { agent: AGENT_NAME });
    const promptKind = this.promptKind(kind);
    const prompt = await readSessionPrompt(promptKind);
    const current = workspace.sessions[sessionID];
    this.updateSessionRegistry(workspace, sessionID, {
      last_auto_prompt_at: nowIso(),
      last_auto_prompt_kind: promptKind,
      status: "active",
      ...(promptKind === "writeup" ? { writeup_prompt_sent_at: current?.writeup_prompt_sent_at ?? nowIso() } : {}),
    });
    await this.save();
    await this.log(`sending ${promptKind} prompt to ${workspace.challenge}/${sessionID}`);
    const result = await session.runAgent(prompt, { agent: AGENT_NAME });
    if (result?.error) {
      throw new Error(`agent turn failed: ${errorSummary(result.error)}`);
    }
    const solved = (await getChallengeInfo(workspace.challenge)).solved;
    this.updateSessionRegistry(workspace, sessionID, {
      last_response_at: nowIso(),
      last_error: "",
      status: solved ? "completed" : "idle",
    });
    await this.save();
    await this.syncSessions(workspace).catch((error) => this.log(`sync ${workspace.challenge} after ${promptKind} failed: ${error.message}`));
  }

  async runAutoSessionLoop(challenge, sessionID, initialKind) {
    let kind = this.promptKind(initialKind);
    let failures = 0;
    while (!this.stopping) {
      const workspace = this.state.workspaces[challenge];
      if (!workspace || workspace.status !== "running") {
        return;
      }
      const registry = workspace.sessions[sessionID];
      if (!registry || registry.mode !== "auto") {
        return;
      }
      if (registry.status === "active") {
        return;
      }

      const info = await getChallengeInfo(challenge);
      if (info.solved && registry.writeup_prompt_sent_at) {
        return;
      }
      if (info.solved) {
        kind = "writeup";
      }

      try {
        await this.sendAutoPromptTurn(workspace, sessionID, kind);
        failures = 0;
        if (kind === "writeup") {
          return;
        }
        kind = (await getChallengeInfo(challenge)).solved ? "writeup" : "continue";
      } catch (error) {
        const message = errorSummary(error);
        this.updateSessionRegistry(workspace, sessionID, {
          last_error: message,
          status: "unknown",
        });
        await this.save();
        await this.log(`session ${sessionID} ${kind} failed: ${message}`);
        const delay = AUTO_ERROR_BACKOFF_MS[Math.min(failures, AUTO_ERROR_BACKOFF_MS.length - 1)];
        failures += 1;
        await sleep(delay);
      }
    }
  }

  async tick() {
    if (this.stopping) {
      return;
    }
    await this.refreshWorkspaceContainerStates();
    for (const workspace of Object.values(this.state.workspaces)) {
      if (workspace.status !== "running") {
        continue;
      }
      await this.syncSessions(workspace).catch((error) => this.log(`sync ${workspace.challenge} failed: ${error.message}`));
      await this.maybeDriveWorkspace(workspace).catch((error) => this.log(`drive ${workspace.challenge} failed: ${error.message}`));
    }
  }

  async maybeDriveWorkspace(workspace) {
    const info = await getChallengeInfo(workspace.challenge);
    const sessions = Object.values(workspace.sessions ?? {});
    if (info.solved) {
      for (const session of sessions) {
        if (session.mode === "auto" && !session.writeup_prompt_sent_at && session.status !== "active") {
          this.driveSession(workspace.challenge, session.session_id, "writeup");
        }
      }
      return;
    }
    for (const session of sessions) {
      if (session.mode !== "auto" || session.status === "active") {
        continue;
      }
      const kind = session.last_auto_prompt_at ? "continue" : "initial";
      this.driveSession(workspace.challenge, session.session_id, kind);
      await sleep(20);
    }
  }
}

export async function runManager() {
  const manager = new FlagDockManager();
  process.on("SIGTERM", () => {
    manager.close().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    manager.close().then(() => process.exit(0));
  });
  await manager.listen(Number.parseInt(process.env.FLAGDOCK_MANAGER_PORT ?? "0", 10));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runManager().catch(async (error) => {
    await appendText(LOG_PATH, `[${nowIso()}] fatal: ${error.stack ?? error.message}\n`).catch(() => {});
    process.exit(1);
  });
}

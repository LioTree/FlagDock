import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import {
  AGENT_NAME,
  BACKENDS,
  CODEX_PORT,
  CONTAINER_CHALLENGE_DIR,
  DEFAULT_MANAGER_HOST,
  LOG_PATH,
  OPENCODE_PORT,
  SOLUTION_FLAG_FILE,
  SOLUTION_WRITEUP_FILE,
} from "./constants.js";
import { CodexAppClient, codexContainerWsUrl, codexHttpUrl, codexWsUrl, waitForCodex } from "./codex.js";
import { getChallengeInfo, getChallengeInfoAtPath, removeChallengeSolutionStateDirIfEmpty, scanChallenges } from "./challenges.js";
import { buildWorkspaceUrls, loadFlagDockConfig } from "./config.js";
import {
  backendContainerName,
  backendChallengeDir,
  containerHostPort,
  containerStatus,
  ensureImages,
  inspectContainer,
  removeBackendWorkspaceDir,
  removeChallengeWorkspaceDirIfEmpty,
  removeWorkspaceContainer,
  runDocker,
  startCodexWorkspaceContainer,
  startWorkspaceContainer,
  stopWorkspaceContainer,
} from "./docker.js";
import { createAttachedRuntime, defaultSessionOptions, requireData, waitForOpenCode } from "./opencode.js";
import { ensureAgentRuntimeFiles, readSessionPrompt } from "./prompts.js";
import { loadState, saveDaemonInfo, saveState } from "./state.js";
import { appendText, attachDirectorySegment, ensureDir, nonEmptyFile, nowIso, pathExists, sleep } from "./util.js";

const DEFAULT_MODE = "auto";
const VALID_MODES = new Set(["auto", "manual"]);
const VALID_BACKENDS = new Set(BACKENDS);
const AUTO_ERROR_BACKOFF_MS = [15000, 30000, 60000, 120000, 300000];

function validateMode(mode, fallback = DEFAULT_MODE) {
  const selected = mode ?? fallback;
  if (!VALID_MODES.has(selected)) {
    throw new Error(`Invalid mode: ${selected}`);
  }
  return selected;
}

function validateBackend(backend) {
  if (!VALID_BACKENDS.has(backend)) {
    throw new Error(`Invalid backend: ${backend}`);
  }
  return backend;
}

function configuredBackends(mode) {
  return mode === "race" ? [...BACKENDS] : [validateBackend(mode)];
}

function backendPort(backend) {
  return backend === "codex" ? CODEX_PORT : OPENCODE_PORT;
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

function normalizeCodexThreadStatus(status, solved) {
  if (status?.type === "active") {
    return "active";
  }
  if (status?.type === "idle") {
    return solved ? "completed" : "idle";
  }
  if (status?.type === "systemError") {
    return "unknown";
  }
  return solved ? "completed" : "unknown";
}

function sessionUrl(baseUrl, sessionID) {
  return `${baseUrl}/${attachDirectorySegment(CONTAINER_CHALLENGE_DIR)}/session/${sessionID}`;
}

function codexAttachSessionName(sessionID) {
  return `codex-${sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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

function isCodexUnmaterializedThreadError(error) {
  return errorSummary(error).includes(" is not materialized");
}

function emptyBackendState(backend) {
  return {
    backend,
    status: "available",
    sessions: {},
    updatedAt: nowIso(),
  };
}

function sessionCollection(backendState) {
  backendState.sessions ??= {};
  return backendState.sessions;
}

export class FlagDockManager {
  constructor() {
    this.state = null;
    this.startedAt = nowIso();
    this.server = null;
    this.runtimes = new Map();
    this.codexClients = new Map();
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

  async configuredChallengeInfo(challenge, config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    return getChallengeInfo(challenge, resolvedConfig.workspace.challengesDir);
  }

  async workspaceChallengeInfo(workspace, config = null) {
    if (workspace?.sourceDir) {
      return getChallengeInfoAtPath(workspace.challenge, workspace.sourceDir);
    }
    return this.configuredChallengeInfo(workspace.challenge, config);
  }

  async challengeInfoForAction(challenge, config = null) {
    const workspace = this.state.workspaces[challenge];
    if (workspace) {
      return this.workspaceChallengeInfo(workspace, config);
    }
    return this.configuredChallengeInfo(challenge, config);
  }

  async configuredChallengeList(config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    return scanChallenges(resolvedConfig.workspace.challengesDir, this.state.workspaces);
  }

  async save() {
    await saveState(this.state);
  }

  async listen(port = 0) {
    await this.load();
    await ensureAgentRuntimeFiles();

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
    for (const client of this.codexClients.values()) {
      client.dispose();
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
      this.writeJson(response, 200, { challenges: await this.configuredChallengeList() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/start") {
      this.writeJson(response, 200, await this.startChallenge(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/start-all") {
      this.writeJson(response, 200, await this.startAllChallenges(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/reset") {
      this.writeJson(response, 200, await this.resetChallenge(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/reset-all") {
      this.writeJson(response, 200, await this.resetAllChallenges());
      return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
      this.writeJson(response, 200, { sessions: await this.listSessions(url.searchParams.get("challenge"), url.searchParams.get("backend")) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/attach") {
      this.writeJson(response, 200, await this.attach(url.searchParams.get("challenge"), url.searchParams.get("session"), url.searchParams.get("backend")));
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
    if (request.method === "POST" && url.pathname === "/workspace/clear") {
      this.writeJson(response, 200, await this.removeWorkspace(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop-all") {
      this.writeJson(response, 200, await this.stopAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear-all") {
      this.writeJson(response, 200, await this.removeAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop-solved") {
      this.writeJson(response, 200, await this.stopSolvedWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear-solved") {
      this.writeJson(response, 200, await this.removeSolvedWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      this.writeJson(response, 200, { ok: true });
      setTimeout(() => this.close().then(() => process.exit(0)), 20);
      return;
    }
    this.writeJson(response, 404, { error: "not found" });
  }

  getWorkspace(challenge) {
    const existing = this.state.workspaces[challenge];
    if (existing) {
      existing.backends ??= {};
      for (const backend of Object.keys(existing.backends)) {
        existing.backends[backend].backend ??= backend;
        existing.backends[backend].sessions ??= {};
      }
      return existing;
    }
    const workspace = {
      challenge,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      backends: {},
    };
    this.state.workspaces[challenge] = workspace;
    return workspace;
  }

  ensureBackendState(workspace, backend) {
    validateBackend(backend);
    workspace.backends ??= {};
    const existing = workspace.backends[backend];
    if (existing) {
      existing.backend = backend;
      existing.sessions ??= {};
      return existing;
    }
    const created = emptyBackendState(backend);
    workspace.backends[backend] = created;
    return created;
  }

  backendState(workspace, backend) {
    validateBackend(backend);
    return workspace.backends?.[backend] ?? null;
  }

  async resolveActionBackend(requestedBackend) {
    if (requestedBackend) {
      return validateBackend(requestedBackend);
    }
    const config = await loadFlagDockConfig();
    if (config.backend.mode === "race") {
      throw new Error("backend is required when backend.mode is race");
    }
    return config.backend.mode;
  }

  aggregateWorkspaceStatus(workspace, info = null) {
    if (info?.solved) {
      return "solved";
    }
    const backends = Object.values(workspace.backends ?? {});
    if (backends.some((backend) => backend.status === "running")) {
      return "running";
    }
    if (backends.length > 0) {
      return "stopped";
    }
    return info?.baseStatus ?? "available";
  }

  workspaceSummary(workspace, info = null) {
    const opencode = workspace.backends?.opencode;
    const codex = workspace.backends?.codex;
    const backendNames = Object.keys(workspace.backends ?? {}).sort();
    return {
      challenge: workspace.challenge,
      status: this.aggregateWorkspaceStatus(workspace, info),
      backends: backendNames,
      container: opencode?.containerName ?? "",
      server_url: opencode?.serverUrl ?? "",
      attach_server_url: opencode?.attachServerUrl ?? opencode?.serverUrl ?? "",
      primary_session: opencode?.primarySessionId ?? codex?.primarySessionId ?? "",
      codex_container: codex?.containerName ?? "",
      codex_server_url: codex?.serverUrl ?? "",
      codex_primary_session: codex?.primarySessionId ?? "",
      solved_by: workspace.solvedBy ?? info?.solvedBackends?.[0] ?? "",
      sessions: backendNames.reduce((sum, backend) => sum + Object.keys(workspace.backends[backend]?.sessions ?? {}).length, 0),
    };
  }

  async status() {
    await this.refreshWorkspaceContainerStates();
    const workspaces = [];
    for (const workspace of Object.values(this.state.workspaces)) {
      const info = await this.workspaceChallengeInfo(workspace);
      workspaces.push(this.workspaceSummary(workspace, info));
    }
    return {
      ok: true,
      pid: process.pid,
      started_at: this.startedAt,
      workspaces,
    };
  }

  async refreshBackendState(workspace, backend, config = null) {
    const backendState = this.backendState(workspace, backend);
    if (!backendState) {
      return;
    }
    const resolvedConfig = config ?? await loadFlagDockConfig();
    const inspected = await inspectContainer(backendState.containerName ?? backendContainerName(workspace.challenge, backend));
    backendState.challengeDir ??= backendChallengeDir(workspace.challenge, backend);
    backendState.containerName ??= backendContainerName(workspace.challenge, backend);
    if (!inspected) {
      backendState.status = "available";
      delete backendState.hostPort;
      delete backendState.serverUrl;
      delete backendState.attachServerUrl;
      delete backendState.wsUrl;
      backendState.updatedAt = nowIso();
      return;
    }
    backendState.status = containerStatus(inspected) ?? "available";
    const hostPort = containerHostPort(inspected, backendPort(backend));
    if (hostPort) {
      backendState.hostPort = hostPort;
      if (backend === "codex") {
        const bindHost = resolvedConfig.workspace.bindHost;
        const internalHost = bindHost === "0.0.0.0" ? DEFAULT_MANAGER_HOST : bindHost;
        backendState.serverUrl = codexHttpUrl(internalHost, hostPort);
        backendState.wsUrl = codexWsUrl(internalHost, hostPort);
        backendState.attachServerUrl = codexHttpUrl(resolvedConfig.attach.host, hostPort);
      } else {
        const urls = buildWorkspaceUrls(resolvedConfig, hostPort);
        backendState.serverUrl = urls.serverUrl;
        backendState.attachServerUrl = urls.attachServerUrl;
      }
    }
    backendState.updatedAt = nowIso();
  }

  async refreshWorkspaceContainerState(workspace, config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    for (const backend of Object.keys(workspace.backends ?? {})) {
      await this.refreshBackendState(workspace, backend, resolvedConfig);
      await this.syncBackendOutputs(workspace, backend);
    }
    await this.reconcileSolvedBy(workspace);
  }

  async refreshWorkspaceContainerStates() {
    const config = await loadFlagDockConfig();
    for (const workspace of Object.values(this.state.workspaces)) {
      await this.refreshWorkspaceContainerState(workspace, config);
    }
    await this.save();
  }

  async reconcileSolvedBy(workspace, info = null) {
    const resolvedInfo = info ?? await this.workspaceChallengeInfo(workspace);
    if (workspace.solvedBy && resolvedInfo.solvedBackends.includes(workspace.solvedBy)) {
      return workspace.solvedBy;
    }
    workspace.solvedBy = resolvedInfo.solvedBackends[0] ?? "";
    return workspace.solvedBy || null;
  }

  async prepareChallengeBackends(challenge, backends) {
    const config = await loadFlagDockConfig();
    const info = await this.configuredChallengeInfo(challenge, config);
    if (!info.valid) {
      throw new Error(`Challenge ${challenge} is invalid or missing challenge.md`);
    }
    const resolvedBackends = [...new Set(backends.map((backend) => validateBackend(backend)))];
    await ensureAgentRuntimeFiles();
    await ensureImages(resolvedBackends, (message) => this.log(message));
    const workspace = this.getWorkspace(challenge);
    if (workspace.sourceDir && path.resolve(workspace.sourceDir) !== path.resolve(info.dir)) {
      throw new Error(`Workspace ${challenge} is already bound to ${workspace.sourceDir}; remove it before using ${info.dir}`);
    }
    workspace.sourceDir ??= info.dir;
    for (const backend of resolvedBackends) {
      await this.ensureBackendWorkspace(workspace, backend, info, config);
    }
    await this.reconcileSolvedBy(workspace, info);
    await this.save();
    return { info, config, workspace };
  }

  async ensureBackendWorkspace(workspace, backend, info, config) {
    const backendState = this.ensureBackendState(workspace, backend);
    if (backend === "codex") {
      const container = await startCodexWorkspaceContainer({
        bindHost: config.workspace.bindHost,
        challenge: workspace.challenge,
        challengeDir: info.dir,
        log: (message) => this.log(message),
      });
      const bindHost = config.workspace.bindHost;
      const internalHost = bindHost === "0.0.0.0" ? DEFAULT_MANAGER_HOST : bindHost;
      Object.assign(backendState, {
        ...container,
        backend,
        challenge: workspace.challenge,
        challengeDir: container.challengeDir,
        sessions: sessionCollection(backendState),
        serverUrl: codexHttpUrl(internalHost, container.hostPort),
        wsUrl: codexWsUrl(internalHost, container.hostPort),
        attachServerUrl: codexHttpUrl(config.attach.host, container.hostPort),
        updatedAt: nowIso(),
      });
      workspace.updatedAt = nowIso();
      await this.save();
      await waitForCodex(backendState.serverUrl);
      await this.getCodexClient(backendState);
      return backendState;
    }

    const container = await startWorkspaceContainer({
      bindHost: config.workspace.bindHost,
      challenge: workspace.challenge,
      challengeDir: info.dir,
      log: (message) => this.log(message),
    });
    const urls = buildWorkspaceUrls(config, container.hostPort);
    Object.assign(backendState, {
      ...container,
      backend,
      challenge: workspace.challenge,
      challengeDir: container.challengeDir,
      sessions: sessionCollection(backendState),
      serverUrl: urls.serverUrl,
      attachServerUrl: urls.attachServerUrl,
      updatedAt: nowIso(),
    });
    workspace.updatedAt = nowIso();
    await this.save();
    await this.getRuntime(backendState);
    return backendState;
  }

  async getRuntime(backendState) {
    if (!backendState?.serverUrl) {
      throw new Error("OpenCode backend has no server URL");
    }
    const cached = this.runtimes.get(backendState.serverUrl);
    if (cached) {
      return cached;
    }
    const runtime = await waitForOpenCode(() => createAttachedRuntime(backendState.serverUrl));
    this.runtimes.set(backendState.serverUrl, runtime);
    return runtime;
  }

  async getCodexClient(backendState) {
    if (!backendState?.wsUrl) {
      throw new Error("Codex backend has no WebSocket URL");
    }
    const cached = this.codexClients.get(backendState.wsUrl);
    if (cached) {
      await cached.connect();
      return cached;
    }
    const client = new CodexAppClient(backendState.wsUrl);
    await client.connect();
    this.codexClients.set(backendState.wsUrl, client);
    return client;
  }

  solutionRuntimePaths(workspace, backend) {
    const backendState = this.backendState(workspace, backend);
    if (!backendState?.challengeDir) {
      return null;
    }
    return {
      flagPath: path.join(backendState.challengeDir, SOLUTION_FLAG_FILE),
      writeupPath: path.join(backendState.challengeDir, SOLUTION_WRITEUP_FILE),
    };
  }

  async syncBackendOutputs(workspace, backend) {
    const backendState = this.backendState(workspace, backend);
    if (!backendState?.challengeDir) {
      return { flag: false, writeup: false };
    }
    const info = await this.workspaceChallengeInfo(workspace);
    const solution = info.solutions[backend];
    const runtime = this.solutionRuntimePaths(workspace, backend);
    if (!solution || !runtime) {
      return { flag: false, writeup: false };
    }
    let copiedFlag = false;
    let copiedWriteup = false;
    if (await nonEmptyFile(runtime.flagPath)) {
      await ensureDir(solution.stateDir);
      await fs.copyFile(runtime.flagPath, solution.flagPath);
      copiedFlag = true;
      workspace.solvedBy ??= backend;
    }
    if (await nonEmptyFile(runtime.writeupPath)) {
      await ensureDir(solution.stateDir);
      await fs.copyFile(runtime.writeupPath, solution.writeupPath);
      copiedWriteup = true;
    }
    if (copiedFlag || copiedWriteup) {
      workspace.updatedAt = nowIso();
      await this.reconcileSolvedBy(workspace);
      await this.save();
    }
    return { flag: copiedFlag, writeup: copiedWriteup };
  }

  sessionEntries(workspace) {
    return Object.entries(workspace.backends ?? {}).flatMap(([backend, backendState]) =>
      Object.values(backendState.sessions ?? {}).map((session) => ({ backend, session })),
    );
  }

  clearSolveBroadcastState(workspace) {
    let changed = false;
    if (workspace.solve_event_dispatched_at) {
      delete workspace.solve_event_dispatched_at;
      changed = true;
    }
    for (const { session } of this.sessionEntries(workspace)) {
      if (session.writeup_prompt_sent_at) {
        delete session.writeup_prompt_sent_at;
        changed = true;
      }
    }
    if (changed) {
      workspace.updatedAt = nowIso();
    }
    return changed;
  }

  async interruptOpenCodeSession(workspace, sessionID) {
    const backendState = this.backendState(workspace, "opencode");
    if (!backendState) {
      return false;
    }
    const runtime = await this.getRuntime(backendState);
    const session = await runtime.openSession(sessionID, defaultSessionOptions());
    await session.interrupt();
    return true;
  }

  async activeCodexTurnID(workspace, session) {
    if (session.active_turn_id) {
      return session.active_turn_id;
    }
    const backendState = this.backendState(workspace, "codex");
    if (!backendState) {
      return null;
    }
    const client = await this.getCodexClient(backendState);
    const thread = await client.readThread(session.thread_id);
    const activeTurn = [...(thread?.turns ?? [])].reverse().find((turn) => turn?.status === "inProgress" || turn?.status === "active");
    if (!activeTurn?.id) {
      return null;
    }
    session.active_turn_id = activeTurn.id;
    return activeTurn.id;
  }

  async interruptCodexSession(workspace, session) {
    const backendState = this.backendState(workspace, "codex");
    if (!backendState) {
      return false;
    }
    const turnID = await this.activeCodexTurnID(workspace, session);
    if (!turnID) {
      return false;
    }
    const client = await this.getCodexClient(backendState);
    await client.interruptTurn(session.thread_id, turnID);
    return true;
  }

  async interruptAutoSession(workspace, backend, session) {
    if (backend === "codex") {
      return this.interruptCodexSession(workspace, session);
    }
    return this.interruptOpenCodeSession(workspace, session.session_id);
  }

  async dispatchSolvedWorkspace(workspace) {
    if (workspace.solve_event_dispatched_at) {
      return false;
    }
    const activeSessions = this.sessionEntries(workspace)
      .filter(({ session }) => session.mode === "auto"
        && session.status === "active"
        && !session.writeup_prompt_sent_at
        && session.last_auto_prompt_kind !== "writeup");
    workspace.solve_event_dispatched_at = nowIso();
    workspace.updatedAt = nowIso();
    await this.save();
    if (activeSessions.length === 0) {
      await this.log(`workspace ${workspace.challenge} solved; no active auto sessions to interrupt`);
      return true;
    }
    await this.log(`workspace ${workspace.challenge} solved; interrupting ${activeSessions.length} active auto session(s)`);
    const results = await Promise.allSettled(activeSessions.map(({ backend, session }) => this.interruptAutoSession(workspace, backend, session)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const { backend, session } = activeSessions[index];
        await this.log(`interrupt ${backend}/${session.session_id} failed: ${errorSummary(result.reason)}`);
      }
    }
    return true;
  }

  async syncOpenCodeSessions(workspace) {
    const backendState = this.backendState(workspace, "opencode");
    if (!backendState) {
      return [];
    }
    if (backendState.status !== "running") {
      return Object.values(sessionCollection(backendState));
    }
    const runtime = await this.getRuntime(backendState);
    const [sessions, statuses] = await Promise.all([
      requireData("session.list", runtime.client.session.list({
        directory: CONTAINER_CHALLENGE_DIR,
        limit: 200,
      })),
      requireData("session.status", runtime.client.session.status({
        directory: CONTAINER_CHALLENGE_DIR,
      })).catch(() => ({})),
    ]);
    const solved = (await this.workspaceChallengeInfo(workspace)).solutions.opencode.solved;
    for (const session of sessions) {
      const existing = sessionCollection(backendState)[session.id] ?? {};
      const registry = {
        backend: "opencode",
        session_id: session.id,
        challenge: workspace.challenge,
        directory: CONTAINER_CHALLENGE_DIR,
        role: session.id === backendState.primarySessionId ? "primary" : (existing.role ?? "auxiliary"),
        source: existing.source ?? "discovered",
        mode: existing.mode ?? "manual",
        created_at: existing.created_at ?? new Date(session.time.created).toISOString(),
        last_seen_at: nowIso(),
        status: normalizeSessionStatus(statuses[session.id], session, solved),
        url: sessionUrl(backendState.attachServerUrl ?? backendState.serverUrl, session.id),
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
      sessionCollection(backendState)[session.id] = registry;
    }
    for (const session of Object.values(sessionCollection(backendState))) {
      if (!sessions.some((item) => item.id === session.session_id) && session.status !== "closed") {
        session.status = "unknown";
      }
    }
    await this.save();
    return Object.values(sessionCollection(backendState));
  }

  async syncCodexSessions(workspace) {
    const backendState = this.backendState(workspace, "codex");
    if (!backendState) {
      return [];
    }
    if (backendState.status !== "running") {
      return Object.values(sessionCollection(backendState));
    }
    const solved = (await this.workspaceChallengeInfo(workspace)).solutions.codex.solved;
    const client = await this.getCodexClient(backendState);
    for (const session of Object.values(sessionCollection(backendState))) {
      if (!session.thread_id) {
        continue;
      }
      try {
        const thread = await client.readThread(session.thread_id);
        session.status = normalizeCodexThreadStatus(thread.status, solved);
        session.title = thread.name ?? thread.preview ?? session.title ?? "";
        session.last_seen_at = nowIso();
        if (session.status !== "active") {
          session.active_turn_id = "";
        }
        session.last_error = "";
      } catch (error) {
        if (isCodexUnmaterializedThreadError(error)) {
          session.status = session.status === "active" ? "active" : "idle";
          session.last_seen_at = nowIso();
          session.last_error = "";
          continue;
        }
        session.last_error = errorSummary(error);
      }
    }
    await this.save();
    return Object.values(sessionCollection(backendState));
  }

  async syncSessions(workspace, backend) {
    validateBackend(backend);
    if (backend === "codex") {
      return this.syncCodexSessions(workspace);
    }
    return this.syncOpenCodeSessions(workspace);
  }

  registerOpenCodeSession(workspace, sessionID, { role, mode }) {
    const backendState = this.ensureBackendState(workspace, "opencode");
    const existing = sessionCollection(backendState)[sessionID] ?? {};
    const registry = {
      backend: "opencode",
      session_id: sessionID,
      challenge: workspace.challenge,
      directory: CONTAINER_CHALLENGE_DIR,
      role,
      source: "managed",
      mode,
      created_at: existing.created_at ?? nowIso(),
      last_seen_at: nowIso(),
      status: existing.status ?? "unknown",
      url: sessionUrl(backendState.attachServerUrl ?? backendState.serverUrl, sessionID),
      title: existing.title ?? "",
      last_auto_prompt_at: existing.last_auto_prompt_at,
      last_auto_prompt_kind: existing.last_auto_prompt_kind,
      last_response_at: existing.last_response_at,
      writeup_prompt_sent_at: existing.writeup_prompt_sent_at,
      last_error: existing.last_error ?? "",
    };
    sessionCollection(backendState)[sessionID] = registry;
    return registry;
  }

  registerCodexSession(workspace, thread, { role, mode }) {
    const backendState = this.ensureBackendState(workspace, "codex");
    const existing = sessionCollection(backendState)[thread.id] ?? {};
    const registry = {
      backend: "codex",
      session_id: thread.id,
      thread_id: thread.id,
      challenge: workspace.challenge,
      directory: CONTAINER_CHALLENGE_DIR,
      role,
      source: "managed",
      mode,
      created_at: existing.created_at ?? (thread.createdAt ? new Date(thread.createdAt * 1000).toISOString() : nowIso()),
      last_seen_at: nowIso(),
      status: normalizeCodexThreadStatus(thread.status, false),
      url: backendState.wsUrl ?? "",
      title: existing.title ?? thread.name ?? thread.preview ?? "",
      last_auto_prompt_at: existing.last_auto_prompt_at,
      last_auto_prompt_kind: existing.last_auto_prompt_kind,
      last_response_at: existing.last_response_at,
      writeup_prompt_sent_at: existing.writeup_prompt_sent_at,
      active_turn_id: existing.active_turn_id,
      last_error: existing.last_error ?? "",
    };
    sessionCollection(backendState)[thread.id] = registry;
    return registry;
  }

  sessionRegistry(workspace, backend, sessionID) {
    return this.backendState(workspace, backend)?.sessions?.[sessionID] ?? null;
  }

  updateSessionRegistry(workspace, backend, sessionID, values) {
    const registry = this.sessionRegistry(workspace, backend, sessionID);
    if (!registry) {
      return null;
    }
    Object.assign(registry, values);
    return registry;
  }

  async ensurePrimarySession(workspace, backend, mode) {
    const backendState = this.ensureBackendState(workspace, backend);
    if (backend === "codex") {
      let primary = backendState.primarySessionId ? sessionCollection(backendState)[backendState.primarySessionId] : null;
      if (!primary) {
        const client = await this.getCodexClient(backendState);
        const thread = await client.startThread();
        backendState.primarySessionId = thread.id;
        primary = this.registerCodexSession(workspace, thread, { role: "primary", mode });
      } else {
        primary.mode = mode;
      }
      return primary;
    }

    let primary = backendState.primarySessionId ? sessionCollection(backendState)[backendState.primarySessionId] : null;
    if (!primary) {
      const runtime = await this.getRuntime(backendState);
      const session = await runtime.createSession(defaultSessionOptions());
      backendState.primarySessionId = session.id;
      primary = this.registerOpenCodeSession(workspace, session.id, { role: "primary", mode });
    } else {
      primary.mode = mode;
    }
    return primary;
  }

  async listSessions(challenge, backend = null) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    if (backend) {
      validateBackend(backend);
    }
    const workspace = this.state.workspaces[challenge];
    if (!workspace) {
      return [];
    }
    await this.refreshWorkspaceContainerState(workspace);
    const selectedBackends = backend ? [backend] : Object.keys(workspace.backends ?? {});
    const sessions = [];
    for (const item of selectedBackends) {
      if (!this.backendState(workspace, item)) {
        continue;
      }
      await this.syncSessions(workspace, item);
      sessions.push(...Object.values(this.backendState(workspace, item).sessions ?? {}).map((session) => ({ backend: item, ...session })));
    }
    return sessions.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  codexAttachTarget(workspace, session) {
    const backendState = this.backendState(workspace, "codex");
    const tmuxSession = codexAttachSessionName(session.session_id);
    const container = backendState.containerName;
    const argv = ["docker", "exec", "-it", container, "tmux", "attach-session", "-t", tmuxSession];
    return {
      challenge: workspace.challenge,
      backend: "codex",
      session: session.session_id,
      role: session.role ?? "",
      status: session.status ?? "",
      thread_id: session.thread_id,
      tmux_session: tmuxSession,
      argv,
      command: argv.map(shellQuote).join(" "),
      url: backendState.wsUrl,
    };
  }

  async attachCodex(workspace, session) {
    const backendState = this.backendState(workspace, "codex");
    if (!backendState || backendState.status !== "running") {
      throw new Error(`Codex workspace ${workspace.challenge} is not running`);
    }
    const target = this.codexAttachTarget(workspace, session);
    const command = `codex --remote ${codexContainerWsUrl()} resume ${session.thread_id} --no-alt-screen`;
    const hasSession = await runDocker(["exec", backendState.containerName, "tmux", "has-session", "-t", target.tmux_session])
      .then(() => true)
      .catch(() => false);
    if (!hasSession) {
      await runDocker(["exec", backendState.containerName, "tmux", "new-session", "-d", "-s", target.tmux_session, command]);
    }
    return target;
  }

  attachTarget(workspace, backend, session) {
    if (backend === "codex") {
      return this.codexAttachTarget(workspace, session);
    }
    return {
      challenge: workspace.challenge,
      backend: "opencode",
      session: session.session_id,
      role: session.role ?? "",
      status: session.status ?? "",
      url: session.url,
      command: session.url,
    };
  }

  async resolveAttachTarget(workspace, backend, session) {
    if (backend === "codex") {
      return this.attachCodex(workspace, session);
    }
    return this.attachTarget(workspace, backend, session);
  }

  async listAttachTargets(challenge = null, backend = null) {
    if (backend) {
      validateBackend(backend);
    }
    const workspaces = challenge
      ? [this.state.workspaces[challenge]].filter(Boolean)
      : Object.values(this.state.workspaces);
    const rows = [];
    for (const workspace of workspaces) {
      await this.refreshWorkspaceContainerState(workspace);
      const selectedBackends = backend ? [backend] : Object.keys(workspace.backends ?? {});
      for (const item of selectedBackends) {
        const backendState = this.backendState(workspace, item);
        if (!backendState) {
          continue;
        }
        await this.syncSessions(workspace, item);
        for (const session of Object.values(backendState.sessions ?? {})) {
          const base = {
            challenge: workspace.challenge,
            backend: item,
            session: session.session_id,
            role: session.role ?? "",
            status: session.status ?? "",
          };
          if (backendState.status !== "running") {
            rows.push({ ...base, attach: "not running" });
            continue;
          }
          const target = await this.resolveAttachTarget(workspace, item, session);
          rows.push({ ...base, attach: target.command ?? target.url ?? "", url: target.url ?? "", command: target.command ?? "" });
        }
      }
    }
    return rows.sort((a, b) =>
      a.challenge.localeCompare(b.challenge)
      || a.backend.localeCompare(b.backend)
      || a.session.localeCompare(b.session),
    );
  }

  async attach(challenge, sessionID, backend = null) {
    if (!challenge) {
      return { mode: "list", attach: await this.listAttachTargets(null, backend) };
    }
    const workspace = this.state.workspaces[challenge];
    if (!workspace) {
      if (backend || sessionID) {
        throw new Error(`Workspace ${challenge} is not running`);
      }
      return { mode: "list", attach: [] };
    }
    await this.refreshWorkspaceContainerState(workspace);

    if (!backend && !sessionID) {
      return { mode: "list", attach: await this.listAttachTargets(challenge) };
    }

    let selectedBackend = backend ? validateBackend(backend) : null;
    if (!selectedBackend && sessionID) {
      const matches = [];
      for (const item of Object.keys(workspace.backends ?? {})) {
        const backendState = this.backendState(workspace, item);
        if (!backendState) {
          continue;
        }
        await this.syncSessions(workspace, item);
        if (backendState.sessions?.[sessionID]) {
          matches.push(item);
        }
      }
      if (matches.length > 1) {
        throw new Error(`Session ${sessionID} exists in multiple backends; pass --backend`);
      }
      selectedBackend = matches[0] ?? await this.resolveActionBackend(null);
    }

    const backendState = this.backendState(workspace, selectedBackend);
    if (!backendState || backendState.status !== "running") {
      throw new Error(`${selectedBackend} workspace ${challenge} is not running`);
    }
    await this.syncSessions(workspace, selectedBackend);
    const selected = sessionID || backendState.primarySessionId;
    const session = selected ? backendState.sessions?.[selected] : null;
    if (!selected || !session) {
      throw new Error(`Session not found for ${challenge}`);
    }
    return { mode: "target", ...await this.resolveAttachTarget(workspace, selectedBackend, session) };
  }

  async startChallenge({ challenge, mode, force }) {
    if (force) {
      throw new Error("force start is not supported");
    }
    const selectedMode = validateMode(mode);
    const config = await loadFlagDockConfig();
    const backends = configuredBackends(config.backend.mode);
    const info = await this.configuredChallengeInfo(challenge, config);
    if (!info.valid) {
      throw new Error(`Challenge ${challenge} is invalid or missing challenge.md`);
    }
    if (selectedMode === "auto" && info.solved) {
      return {
        skipped: true,
        reason: "solved",
        challenge,
        solved_by: info.solvedBackends,
      };
    }

    const { workspace } = await this.prepareChallengeBackends(challenge, backends);
    const primaries = {};
    for (const backend of backends) {
      await this.syncBackendOutputs(workspace, backend);
      await this.syncSessions(workspace, backend);
      primaries[backend] = await this.ensurePrimarySession(workspace, backend, selectedMode);
    }
    await this.reconcileSolvedBy(workspace);
    await this.save();
    if (selectedMode === "auto") {
      for (const backend of backends) {
        this.driveSession(workspace.challenge, primaries[backend].session_id, "initial", backend)
          .catch((error) => this.log(`${backend} drive failed: ${error.message}`));
      }
    }
    const firstBackend = backends[0];
    return {
      workspace: this.workspaceSummary(workspace, await this.workspaceChallengeInfo(workspace)),
      backend_mode: config.backend.mode,
      primary_session: primaries[firstBackend],
      opencode_primary_session: primaries.opencode,
      codex_primary_session: primaries.codex,
    };
  }

  async newSession({ challenge, mode, backend }) {
    const selectedMode = validateMode(mode, "auto");
    const selectedBackend = await this.resolveActionBackend(backend);
    const { workspace } = await this.prepareChallengeBackends(challenge, [selectedBackend]);
    let registry;
    if (selectedBackend === "codex") {
      const client = await this.getCodexClient(this.backendState(workspace, "codex"));
      const thread = await client.startThread();
      registry = this.registerCodexSession(workspace, thread, {
        role: "auxiliary",
        mode: selectedMode,
      });
    } else {
      const runtime = await this.getRuntime(this.backendState(workspace, "opencode"));
      const session = await runtime.createSession(defaultSessionOptions());
      registry = this.registerOpenCodeSession(workspace, session.id, {
        role: "auxiliary",
        mode: selectedMode,
      });
    }
    await this.save();
    if (selectedMode === "auto") {
      this.driveSession(workspace.challenge, registry.session_id, "initial", selectedBackend)
        .catch((error) => this.log(`${selectedBackend} drive failed: ${error.message}`));
    }
    return { session: registry };
  }

  async setMode({ challenge, session, mode, backend }) {
    const selectedMode = validateMode(mode);
    const selectedBackend = await this.resolveActionBackend(backend);
    const workspace = this.state.workspaces[challenge];
    if (!workspace) {
      throw new Error(`Workspace ${challenge} does not exist`);
    }
    await this.syncSessions(workspace, selectedBackend);
    const registry = this.sessionRegistry(workspace, selectedBackend, session);
    if (!registry) {
      throw new Error(`Session ${session} not found`);
    }
    registry.mode = selectedMode;
    await this.save();
    if (selectedMode === "auto") {
      const kind = registry.last_auto_prompt_at ? "continue" : "initial";
      this.driveSession(workspace.challenge, registry.session_id, kind, selectedBackend)
        .catch((error) => this.log(`${selectedBackend} drive failed: ${error.message}`));
    }
    return { session: registry };
  }

  async disposeBackendRuntime(backendState) {
    if (!backendState) {
      return;
    }
    if (backendState.serverUrl && this.runtimes.has(backendState.serverUrl)) {
      const runtime = this.runtimes.get(backendState.serverUrl);
      await runtime?.dispose().catch(() => {});
      this.runtimes.delete(backendState.serverUrl);
    }
    if (backendState.wsUrl && this.codexClients.has(backendState.wsUrl)) {
      this.codexClients.get(backendState.wsUrl)?.dispose();
      this.codexClients.delete(backendState.wsUrl);
    }
  }

  async stopWorkspace({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const workspace = this.state.workspaces[challenge] ?? this.getWorkspace(challenge);
    const results = {};
    for (const backend of BACKENDS) {
      results[backend] = await stopWorkspaceContainer(challenge, backend);
      const backendState = this.backendState(workspace, backend);
      if (backendState) {
        backendState.status = "stopped";
        backendState.updatedAt = nowIso();
        await this.disposeBackendRuntime(backendState);
      }
    }
    workspace.updatedAt = nowIso();
    await this.save();
    return {
      stopped: Object.values(results).some(Boolean),
      opencode_stopped: results.opencode,
      codex_stopped: results.codex,
      workspace: this.workspaceSummary(workspace, await this.workspaceChallengeInfo(workspace)),
    };
  }

  async removeWorkspace({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const workspace = this.state.workspaces[challenge];
    const results = {};
    for (const backend of BACKENDS) {
      results[backend] = await removeWorkspaceContainer(challenge, backend);
      await removeBackendWorkspaceDir(challenge, backend).catch(() => {});
      await this.disposeBackendRuntime(workspace?.backends?.[backend]);
    }
    await removeChallengeWorkspaceDirIfEmpty(challenge).catch(() => {});
    delete this.state.workspaces[challenge];
    await this.save();
    return {
      removed: Object.values(results).some(Boolean),
      opencode_removed: results.opencode,
      codex_removed: results.codex,
    };
  }

  async resetChallenge({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const info = await this.challengeInfoForAction(challenge);
    if (!info.valid) {
      throw new Error(`Challenge ${challenge} is invalid or missing challenge.md`);
    }

    const solutionRemoved = {};
    for (const backend of BACKENDS) {
      const solution = info.solutions[backend];
      const hadStateDir = solution?.stateDir ? await pathExists(solution.stateDir) : false;
      solutionRemoved[backend] = hadStateDir;
      if (solution?.stateDir) {
        await fs.rm(solution.stateDir, { recursive: true, force: true });
      }
    }
    await removeChallengeSolutionStateDirIfEmpty(challenge, info.dir).catch(() => {});

    const hadWorkspace = Boolean(this.state.workspaces[challenge]);
    const workspaceResult = await this.removeWorkspace({ challenge });
    const refreshed = await getChallengeInfoAtPath(challenge, info.dir);
    return {
      reset: true,
      challenge,
      status: refreshed.baseStatus,
      opencode_state_removed: solutionRemoved.opencode,
      codex_state_removed: solutionRemoved.codex,
      workspace_removed: hadWorkspace || workspaceResult.removed,
    };
  }

  async startAllChallenges({ mode } = {}) {
    const config = await loadFlagDockConfig();
    await this.refreshWorkspaceContainerStates(config);
    const challenges = await this.configuredChallengeList(config);
    const results = [];
    let started = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of challenges) {
      if (item.status !== "available") {
        results.push({
          challenge: item.challenge,
          status: item.status,
          result: "skipped",
          detail: `status=${item.status}`,
        });
        skipped += 1;
        continue;
      }
      try {
        const result = await this.startChallenge({ challenge: item.challenge, mode });
        if (result.skipped) {
          results.push({
            challenge: item.challenge,
            status: item.status,
            result: "skipped",
            detail: result.reason ?? "skipped",
          });
          skipped += 1;
          continue;
        }
        results.push({
          challenge: item.challenge,
          status: result.workspace.status,
          result: "started",
          detail: `mode=${mode ?? "auto"}`,
        });
        started += 1;
      } catch (error) {
        results.push({
          challenge: item.challenge,
          status: item.status,
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        failed += 1;
      }
    }
    return {
      count: results.length,
      started,
      skipped,
      failed,
      challenges: results,
    };
  }

  async resetAllChallenges() {
    const config = await loadFlagDockConfig();
    await this.refreshWorkspaceContainerStates(config);
    const challenges = await this.configuredChallengeList(config);
    const results = [];
    let reset = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of challenges) {
      if (item.status === "invalid") {
        results.push({
          challenge: item.challenge,
          status: item.status,
          result: "skipped",
          detail: "invalid challenge",
        });
        skipped += 1;
        continue;
      }
      try {
        const result = await this.resetChallenge({ challenge: item.challenge });
        const changed = result.workspace_removed || result.opencode_state_removed || result.codex_state_removed;
        results.push({
          challenge: item.challenge,
          status: result.status,
          result: changed ? "reset" : "unchanged",
          detail: changed ? "state cleared" : "already clean",
        });
        if (changed) {
          reset += 1;
        } else {
          unchanged += 1;
        }
      } catch (error) {
        results.push({
          challenge: item.challenge,
          status: item.status,
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        failed += 1;
      }
    }
    return {
      count: results.length,
      reset,
      unchanged,
      skipped,
      failed,
      challenges: results,
    };
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

  async applySolvedWorkspaceAction(action) {
    if (action !== "stop" && action !== "clear") {
      throw new Error(`Invalid workspace action: ${action}`);
    }
    await this.refreshWorkspaceContainerStates();
    const results = [];
    let changed = 0;
    let unchanged = 0;
    let failed = 0;
    for (const challenge of Object.keys(this.state.workspaces).sort()) {
      const workspace = this.state.workspaces[challenge];
      if (!workspace) {
        continue;
      }
      let summary = null;
      try {
        const info = await this.workspaceChallengeInfo(workspace);
        if (!info.solved) {
          continue;
        }
        summary = this.workspaceSummary(workspace, info);
        const container = [summary.container, summary.codex_container].filter(Boolean).join(",");
        if (action === "stop") {
          const result = await this.stopWorkspace({ challenge });
          const stopped = result.stopped === true;
          if (stopped) {
            changed += 1;
          } else {
            unchanged += 1;
          }
          results.push({
            challenge,
            status: result.workspace?.status ?? summary.status,
            solved_by: summary.solved_by,
            container,
            stopped,
            changed: stopped,
            result: stopped ? "stopped" : "unchanged",
            detail: stopped ? "containers stopped" : "no containers found",
          });
          continue;
        }
        await this.removeWorkspace({ challenge });
        changed += 1;
        results.push({
          challenge,
          status: summary.status,
          solved_by: summary.solved_by,
          container,
          removed: true,
          changed: true,
          result: "cleared",
          detail: "runtime workspace removed",
        });
      } catch (error) {
        failed += 1;
        results.push({
          challenge,
          status: summary?.status ?? "",
          solved_by: summary?.solved_by ?? "",
          container: summary ? [summary.container, summary.codex_container].filter(Boolean).join(",") : "",
          changed: false,
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      count: results.length,
      ...(action === "stop" ? { stopped: changed } : { cleared: changed }),
      unchanged,
      failed,
      workspaces: results,
    };
  }

  async stopSolvedWorkspaces() {
    return this.applySolvedWorkspaceAction("stop");
  }

  async removeSolvedWorkspaces() {
    return this.applySolvedWorkspaceAction("clear");
  }

  promptKind(kind) {
    if (kind === "initial" || kind === "writeup") {
      return kind;
    }
    return "continue";
  }

  async driveSession(challenge, sessionID, kind = "continue", backend = "opencode") {
    const key = `${backend}:${challenge}:${sessionID}`;
    if (this.activeAutoLoops.has(key) || this.stopping) {
      return;
    }
    const task = this.runAutoSessionLoop(challenge, sessionID, kind, backend)
      .catch((error) => this.log(`session ${sessionID} auto loop failed: ${error.message}`))
      .finally(() => this.activeAutoLoops.delete(key));
    this.activeAutoLoops.set(key, task);
  }

  async sendOpenCodeAutoPromptTurn(workspace, sessionID, kind) {
    const backendState = this.backendState(workspace, "opencode");
    const runtime = await this.getRuntime(backendState);
    const session = await runtime.openSession(sessionID, { agent: AGENT_NAME });
    const promptKind = this.promptKind(kind);
    const prompt = await readSessionPrompt(promptKind);
    const current = this.sessionRegistry(workspace, "opencode", sessionID);
    this.updateSessionRegistry(workspace, "opencode", sessionID, {
      last_auto_prompt_at: nowIso(),
      last_auto_prompt_kind: promptKind,
      status: "active",
      ...(promptKind === "writeup" ? { writeup_prompt_sent_at: current?.writeup_prompt_sent_at ?? nowIso() } : {}),
    });
    await this.save();
    await this.log(`sending ${promptKind} prompt to opencode ${workspace.challenge}/${sessionID}`);
    const result = await session.runAgent(prompt, { agent: AGENT_NAME });
    if (result?.error) {
      throw new Error(`agent turn failed: ${errorSummary(result.error)}`);
    }
    await this.syncBackendOutputs(workspace, "opencode");
    const solved = (await this.workspaceChallengeInfo(workspace)).solved;
    await this.reconcileSolvedBy(workspace);
    this.updateSessionRegistry(workspace, "opencode", sessionID, {
      last_response_at: nowIso(),
      last_error: "",
      status: solved ? "completed" : "idle",
    });
    await this.save();
    await this.syncOpenCodeSessions(workspace).catch((error) => this.log(`sync ${workspace.challenge} after ${promptKind} failed: ${error.message}`));
  }

  async sendCodexAutoPromptTurn(workspace, sessionID, kind) {
    const backendState = this.backendState(workspace, "codex");
    const session = this.sessionRegistry(workspace, "codex", sessionID);
    if (!backendState || !session) {
      throw new Error(`Codex session ${sessionID} not found`);
    }
    const client = await this.getCodexClient(backendState);
    if (session.last_auto_prompt_at) {
      await client.resumeThread(session.thread_id);
    }
    const promptKind = this.promptKind(kind);
    const prompt = await readSessionPrompt(promptKind);
    this.updateSessionRegistry(workspace, "codex", sessionID, {
      last_auto_prompt_at: nowIso(),
      last_auto_prompt_kind: promptKind,
      status: "active",
      ...(promptKind === "writeup" ? { writeup_prompt_sent_at: session.writeup_prompt_sent_at ?? nowIso() } : {}),
    });
    await this.save();
    await this.log(`sending ${promptKind} prompt to codex ${workspace.challenge}/${sessionID}`);
    const pendingTurn = await client.startTurn(session.thread_id, prompt);
    this.updateSessionRegistry(workspace, "codex", sessionID, {
      active_turn_id: pendingTurn.id,
    });
    await this.save();
    const turn = await client.waitForTurn(session.thread_id, pendingTurn.id);
    if (turn.status === "failed") {
      throw new Error(`codex turn failed: ${errorSummary(turn.error)}`);
    }
    await this.syncBackendOutputs(workspace, "codex");
    const solved = (await this.workspaceChallengeInfo(workspace)).solved;
    await this.reconcileSolvedBy(workspace);
    this.updateSessionRegistry(workspace, "codex", sessionID, {
      active_turn_id: "",
      last_response_at: nowIso(),
      last_error: "",
      status: solved ? "completed" : "idle",
    });
    await this.save();
    await this.syncCodexSessions(workspace).catch((error) => this.log(`sync codex ${workspace.challenge} after ${promptKind} failed: ${error.message}`));
  }

  async sendAutoPromptTurn(workspace, sessionID, kind, backend) {
    if (backend === "codex") {
      return this.sendCodexAutoPromptTurn(workspace, sessionID, kind);
    }
    return this.sendOpenCodeAutoPromptTurn(workspace, sessionID, kind);
  }

  async runAutoSessionLoop(challenge, sessionID, initialKind, backend) {
    let kind = this.promptKind(initialKind);
    let failures = 0;
    while (!this.stopping) {
      const workspace = this.state.workspaces[challenge];
      const backendState = workspace ? this.backendState(workspace, backend) : null;
      if (!workspace || !backendState || backendState.status !== "running") {
        return;
      }
      const registry = this.sessionRegistry(workspace, backend, sessionID);
      if (!registry || registry.mode !== "auto") {
        return;
      }
      if (registry.status === "active") {
        return;
      }

      const info = await this.workspaceChallengeInfo(workspace);
      await this.reconcileSolvedBy(workspace, info);
      if (info.solved && registry.writeup_prompt_sent_at) {
        return;
      }
      if (info.solved) {
        if (kind !== "writeup") {
          return;
        }
      } else if (kind === "writeup") {
        kind = "continue";
      }

      try {
        await this.sendAutoPromptTurn(workspace, sessionID, kind, backend);
        failures = 0;
        if (kind === "writeup") {
          return;
        }
        if ((await this.workspaceChallengeInfo(workspace)).solved) {
          return;
        }
        kind = "continue";
      } catch (error) {
        const message = errorSummary(error);
        this.updateSessionRegistry(workspace, backend, sessionID, {
          last_error: message,
          status: "unknown",
        });
        await this.save();
        await this.log(`session ${backend}/${sessionID} ${kind} failed: ${message}`);
        const delay = AUTO_ERROR_BACKOFF_MS[Math.min(failures, AUTO_ERROR_BACKOFF_MS.length - 1)];
        failures += 1;
        await sleep(delay);
      }
    }
  }

  async maybeDriveWorkspace(workspace) {
    const info = await this.workspaceChallengeInfo(workspace);
    await this.reconcileSolvedBy(workspace, info);
    const sessions = this.sessionEntries(workspace);
    if (!info.solved && this.clearSolveBroadcastState(workspace)) {
      await this.save();
    }
    if (info.solved) {
      await this.dispatchSolvedWorkspace(workspace);
      for (const { backend, session } of sessions) {
        if (session.mode === "auto" && !session.writeup_prompt_sent_at && session.status !== "active") {
          this.driveSession(workspace.challenge, session.session_id, "writeup", backend);
        }
      }
      return;
    }
    for (const { backend, session } of sessions) {
      if (session.mode !== "auto" || session.status === "active") {
        continue;
      }
      const kind = session.last_auto_prompt_at ? "continue" : "initial";
      this.driveSession(workspace.challenge, session.session_id, kind, backend);
      await sleep(20);
    }
  }

  async tick() {
    if (this.stopping) {
      return;
    }
    await this.refreshWorkspaceContainerStates();
    for (const workspace of Object.values(this.state.workspaces)) {
      for (const backend of Object.keys(workspace.backends ?? {})) {
        await this.syncBackendOutputs(workspace, backend).catch((error) => this.log(`sync outputs ${workspace.challenge}/${backend} failed: ${error.message}`));
        await this.syncSessions(workspace, backend).catch((error) => this.log(`sync ${workspace.challenge}/${backend} failed: ${error.message}`));
      }
      await this.maybeDriveWorkspace(workspace).catch((error) => this.log(`drive ${workspace.challenge} failed: ${error.message}`));
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

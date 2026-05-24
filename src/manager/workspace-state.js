import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MANAGER_HOST, SOLUTION_FLAG_FILE, SOLUTION_WRITEUP_FILE } from "../constants.js";
import { CodexAppClient, codexHttpUrl, codexWsUrl, waitForCodex } from "../codex.js";
import { buildWorkspaceUrls, loadFlagDockConfig } from "../config.js";
import {
  backendChallengeDir,
  backendContainerName,
  containerHostPort,
  containerStatus,
  ensureImages,
  inspectContainer,
  startCodexWorkspaceContainer,
  startWorkspaceContainer,
} from "../docker.js";
import { createAttachedRuntime, waitForOpenCode } from "../opencode.js";
import { ensureAgentRuntimeFiles } from "../prompts.js";
import { ensureDir, nonEmptyFile, nowIso } from "../util.js";
import { backendPort, emptyBackendState, sessionCollection, validateBackend } from "./helpers.js";

export const workspaceStateMethods = {
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
  },

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
  },

  backendState(workspace, backend) {
    validateBackend(backend);
    return workspace.backends?.[backend] ?? null;
  },

  async resolveActionBackend(requestedBackend) {
    if (requestedBackend) {
      return validateBackend(requestedBackend);
    }
    const config = await loadFlagDockConfig();
    if (config.backend.mode === "race") {
      throw new Error("backend is required when backend.mode is race");
    }
    return config.backend.mode;
  },

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
  },

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
  },

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
  },

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
  },

  async refreshWorkspaceContainerState(workspace, config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    for (const backend of Object.keys(workspace.backends ?? {})) {
      await this.refreshBackendState(workspace, backend, resolvedConfig);
      await this.syncBackendOutputs(workspace, backend);
    }
    await this.reconcileSolvedBy(workspace);
  },

  async refreshWorkspaceContainerStates() {
    const config = await loadFlagDockConfig();
    for (const workspace of Object.values(this.state.workspaces)) {
      await this.refreshWorkspaceContainerState(workspace, config);
    }
    await this.save();
  },

  async reconcileSolvedBy(workspace, info = null) {
    const resolvedInfo = info ?? await this.workspaceChallengeInfo(workspace);
    if (workspace.solvedBy && resolvedInfo.solvedBackends.includes(workspace.solvedBy)) {
      return workspace.solvedBy;
    }
    workspace.solvedBy = resolvedInfo.solvedBackends[0] ?? "";
    return workspace.solvedBy || null;
  },

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
  },

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
  },

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
  },

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
  },

  solutionRuntimePaths(workspace, backend) {
    const backendState = this.backendState(workspace, backend);
    if (!backendState?.challengeDir) {
      return null;
    }
    return {
      flagPath: path.join(backendState.challengeDir, SOLUTION_FLAG_FILE),
      writeupPath: path.join(backendState.challengeDir, SOLUTION_WRITEUP_FILE),
    };
  },

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
};

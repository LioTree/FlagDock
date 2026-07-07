import fs from "node:fs/promises";
import path from "node:path";
import { getChallengeInfo, getChallengeInfoAtPath, scanChallenges } from "../../challenges.js";
import { BACKENDS, SOLUTION_FLAG_FILE, SOLUTION_WRITEUP_FILE } from "../../constants.js";
import { loadFlagDockConfig } from "../../config.js";
import {
  backendChallengeDir,
  backendContainerName,
  containerHostPort,
  containerStatus,
  ensureImages,
  inspectContainer,
} from "../../docker.js";
import { ensureAgentRuntimeFiles } from "../../prompts.js";
import { ensureDir, nonEmptyFile, nowIso } from "../../util.js";
import { backendAdapter } from "../backends/index.js";
import { emptyBackendState, sessionCollection, validateBackend } from "../helpers.js";

export function createWorkspaceRuntimeService(ctx) {
  async function configuredChallengeInfo(challenge, config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    return getChallengeInfo(challenge, resolvedConfig.workspace.challengesDir);
  }

  async function workspaceChallengeInfo(workspace, config = null) {
    if (workspace?.sourceDir) {
      return getChallengeInfoAtPath(workspace.challenge, workspace.sourceDir);
    }
    return configuredChallengeInfo(workspace.challenge, config);
  }

  async function challengeInfoForAction(challenge, config = null) {
    const workspace = ctx.state.workspaces[challenge];
    if (workspace) {
      return workspaceChallengeInfo(workspace, config);
    }
    return configuredChallengeInfo(challenge, config);
  }

  async function configuredChallengeList(config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    return scanChallenges(resolvedConfig.workspace.challengesDir, ctx.state.workspaces);
  }

  async function configuredFlags(config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    const challenges = await configuredChallengeList(resolvedConfig);
    const flags = [];
    for (const item of challenges) {
      const info = await configuredChallengeInfo(item.challenge, resolvedConfig);
      if (!info.valid) {
        continue;
      }
      for (const backend of BACKENDS) {
        const solution = info.solutions[backend];
        if (!solution?.flagPath || !await nonEmptyFile(solution.flagPath)) {
          continue;
        }
        const flag = (await fs.readFile(solution.flagPath, "utf8")).trim();
        if (flag) {
          flags.push({ challenge: item.challenge, backend, flag });
        }
      }
    }
    return flags;
  }

  function getWorkspace(challenge) {
    const existing = ctx.state.workspaces[challenge];
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
    ctx.state.workspaces[challenge] = workspace;
    return workspace;
  }

  function ensureBackendState(workspace, backend) {
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

  function backendState(workspace, backend) {
    validateBackend(backend);
    return workspace.backends?.[backend] ?? null;
  }

  async function resolveActionBackend(requestedBackend) {
    if (requestedBackend) {
      return validateBackend(requestedBackend);
    }
    const config = await loadFlagDockConfig();
    if (config.backend.mode === "race") {
      throw new Error("backend is required when backend.mode is race");
    }
    return config.backend.mode;
  }

  function aggregateWorkspaceStatus(workspace, info = null) {
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

  function workspaceSummary(workspace, info = null) {
    const opencode = workspace.backends?.opencode;
    const codex = workspace.backends?.codex;
    const backendNames = Object.keys(workspace.backends ?? {}).sort();
    return {
      challenge: workspace.challenge,
      status: aggregateWorkspaceStatus(workspace, info),
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

  async function status() {
    await refreshWorkspaceContainerStates();
    const workspaces = [];
    for (const workspace of Object.values(ctx.state.workspaces)) {
      const info = await workspaceChallengeInfo(workspace);
      workspaces.push(workspaceSummary(workspace, info));
    }
    return {
      ok: true,
      pid: process.pid,
      started_at: ctx.startedAt,
      workspaces,
    };
  }

  async function refreshBackendState(workspace, backend, config = null) {
    const state = backendState(workspace, backend);
    if (!state) {
      return;
    }
    const resolvedConfig = config ?? await loadFlagDockConfig();
    const adapter = backendAdapter(backend);
    const inspected = await inspectContainer(state.containerName ?? backendContainerName(workspace.challenge, backend));
    state.challengeDir ??= backendChallengeDir(workspace.challenge, backend);
    state.containerName ??= backendContainerName(workspace.challenge, backend);
    if (!inspected) {
      state.status = "available";
      delete state.hostPort;
      delete state.serverUrl;
      delete state.attachServerUrl;
      delete state.wsUrl;
      state.updatedAt = nowIso();
      return;
    }
    state.status = containerStatus(inspected) ?? "available";
    const hostPort = containerHostPort(inspected, adapter.port);
    if (hostPort) {
      state.hostPort = hostPort;
      Object.assign(state, adapter.urls(resolvedConfig, hostPort));
    }
    state.updatedAt = nowIso();
  }

  async function refreshWorkspaceContainerState(workspace, config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    for (const backend of Object.keys(workspace.backends ?? {})) {
      await refreshBackendState(workspace, backend, resolvedConfig);
      await syncBackendOutputs(workspace, backend);
    }
    await reconcileSolvedBy(workspace);
  }

  async function refreshWorkspaceContainerStates(config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    for (const workspace of Object.values(ctx.state.workspaces)) {
      await refreshWorkspaceContainerState(workspace, resolvedConfig);
    }
    await ctx.save();
  }

  async function syncWorkspaceOutputs() {
    const errors = [];
    for (const workspace of Object.values(ctx.state.workspaces)) {
      for (const backend of Object.keys(workspace.backends ?? {})) {
        try {
          await syncBackendOutputs(workspace, backend);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ challenge: workspace.challenge, backend, error: message });
          await ctx.log(`sync outputs ${workspace.challenge}/${backend} failed: ${message}`).catch(() => {});
        }
      }
    }
    return { errors };
  }

  async function reconcileSolvedBy(workspace, info = null) {
    const resolvedInfo = info ?? await workspaceChallengeInfo(workspace);
    if (workspace.solvedBy && resolvedInfo.solvedBackends.includes(workspace.solvedBy)) {
      return workspace.solvedBy;
    }
    workspace.solvedBy = resolvedInfo.solvedBackends[0] ?? "";
    return workspace.solvedBy || null;
  }

  async function prepareChallengeBackends(challenge, backends) {
    const config = await loadFlagDockConfig();
    const info = await configuredChallengeInfo(challenge, config);
    if (!info.valid) {
      throw new Error(`Challenge ${challenge} is invalid or missing challenge.md`);
    }
    const resolvedBackends = [...new Set(backends.map((backend) => validateBackend(backend)))];
    await ensureAgentRuntimeFiles();
    await ensureImages(resolvedBackends, (message) => ctx.log(message));
    const workspace = getWorkspace(challenge);
    if (workspace.sourceDir && path.resolve(workspace.sourceDir) !== path.resolve(info.dir)) {
      throw new Error(`Workspace ${challenge} is already bound to ${workspace.sourceDir}; remove it before using ${info.dir}`);
    }
    workspace.sourceDir ??= info.dir;
    for (const backend of resolvedBackends) {
      await ensureBackendWorkspace(workspace, backend, info, config);
    }
    await reconcileSolvedBy(workspace, info);
    await ctx.save();
    return { info, config, workspace };
  }

  async function ensureBackendWorkspace(workspace, backend, info, config) {
    const state = ensureBackendState(workspace, backend);
    const adapter = backendAdapter(backend);
    const container = await adapter.startContainer(ctx, workspace, info, config);
    Object.assign(state, {
      ...container,
      backend,
      challenge: workspace.challenge,
      challengeDir: container.challengeDir,
      sessions: sessionCollection(state),
      ...adapter.urls(config, container.hostPort),
      updatedAt: nowIso(),
    });
    workspace.updatedAt = nowIso();
    await ctx.save();
    await adapter.waitUntilReady(ctx, state);
    return state;
  }

  function solutionRuntimePaths(workspace, backend) {
    const state = backendState(workspace, backend);
    if (!state?.challengeDir) {
      return null;
    }
    return {
      flagPath: path.join(state.challengeDir, SOLUTION_FLAG_FILE),
      writeupPath: path.join(state.challengeDir, SOLUTION_WRITEUP_FILE),
    };
  }

  async function syncBackendOutputs(workspace, backend) {
    const state = backendState(workspace, backend);
    if (!state?.challengeDir) {
      return { flag: false, writeup: false };
    }
    const info = await workspaceChallengeInfo(workspace);
    const solution = info.solutions[backend];
    const runtime = solutionRuntimePaths(workspace, backend);
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
      await reconcileSolvedBy(workspace);
      await ctx.save();
    }
    return { flag: copiedFlag, writeup: copiedWriteup };
  }

  return {
    configuredChallengeInfo,
    workspaceChallengeInfo,
    challengeInfoForAction,
    configuredChallengeList,
    configuredFlags,
    getWorkspace,
    ensureBackendState,
    backendState,
    resolveActionBackend,
    aggregateWorkspaceStatus,
    workspaceSummary,
    status,
    refreshBackendState,
    refreshWorkspaceContainerState,
    refreshWorkspaceContainerStates,
    syncWorkspaceOutputs,
    reconcileSolvedBy,
    prepareChallengeBackends,
    ensureBackendWorkspace,
    solutionRuntimePaths,
    syncBackendOutputs,
  };
}

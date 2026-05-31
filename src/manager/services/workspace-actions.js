import fs from "node:fs/promises";
import { BACKENDS } from "../../constants.js";
import { getChallengeInfoAtPath, removeChallengeSolutionStateDirIfEmpty } from "../../challenges.js";
import { loadFlagDockConfig } from "../../config.js";
import {
  removeBackendWorkspaceDir,
  removeChallengeWorkspaceDirIfEmpty,
  removeWorkspaceContainer,
  stopWorkspaceContainer,
} from "../../docker.js";
import { nowIso, pathExists } from "../../util.js";
import { backendAdapter } from "../backends/index.js";
import { configuredBackends, validateMode } from "../helpers.js";

export function createWorkspaceActionService(ctx, { workspaceRuntime, sessions, auto }) {
  const backendServices = {
    workspaceRuntime,
    sessions,
  };

  async function startChallenge({ challenge, mode, force }) {
    if (force) {
      throw new Error("force start is not supported");
    }
    const selectedMode = validateMode(mode);
    const config = await loadFlagDockConfig();
    const backends = configuredBackends(config.backend.mode);
    const info = await workspaceRuntime.configuredChallengeInfo(challenge, config);
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

    const { workspace } = await workspaceRuntime.prepareChallengeBackends(challenge, backends);
    const primaries = {};
    for (const backend of backends) {
      await workspaceRuntime.syncBackendOutputs(workspace, backend);
      await sessions.syncSessions(workspace, backend);
      primaries[backend] = await sessions.ensurePrimarySession(workspace, backend, selectedMode);
    }
    await workspaceRuntime.reconcileSolvedBy(workspace);
    await ctx.save();
    if (selectedMode === "auto") {
      for (const backend of backends) {
        auto.driveSession(workspace.challenge, primaries[backend].session_id, "initial", backend)
          .catch((error) => ctx.log(`${backend} drive failed: ${error.message}`));
      }
    }
    const firstBackend = backends[0];
    return {
      workspace: workspaceRuntime.workspaceSummary(workspace, await workspaceRuntime.workspaceChallengeInfo(workspace)),
      backend_mode: config.backend.mode,
      primary_session: primaries[firstBackend],
      opencode_primary_session: primaries.opencode,
      codex_primary_session: primaries.codex,
    };
  }

  async function newSession({ challenge, mode, backend }) {
    const selectedMode = validateMode(mode, "auto");
    const selectedBackend = await workspaceRuntime.resolveActionBackend(backend);
    const { workspace } = await workspaceRuntime.prepareChallengeBackends(challenge, [selectedBackend]);
    const registry = await backendAdapter(selectedBackend).createSession(ctx, backendServices, workspace, selectedMode);
    await ctx.save();
    if (selectedMode === "auto") {
      auto.driveSession(workspace.challenge, registry.session_id, "initial", selectedBackend)
        .catch((error) => ctx.log(`${selectedBackend} drive failed: ${error.message}`));
    }
    return { session: registry };
  }

  async function setMode({ challenge, session, mode, backend }) {
    const selectedMode = validateMode(mode);
    const selectedBackend = await workspaceRuntime.resolveActionBackend(backend);
    const workspace = ctx.state.workspaces[challenge];
    if (!workspace) {
      throw new Error(`Workspace ${challenge} does not exist`);
    }
    await sessions.syncSessions(workspace, selectedBackend);
    const registry = sessions.sessionRegistry(workspace, selectedBackend, session);
    if (!registry) {
      throw new Error(`Session ${session} not found`);
    }
    registry.mode = selectedMode;
    await ctx.save();
    if (selectedMode === "auto") {
      const kind = registry.last_auto_prompt_at ? "continue" : "initial";
      auto.driveSession(workspace.challenge, registry.session_id, kind, selectedBackend)
        .catch((error) => ctx.log(`${selectedBackend} drive failed: ${error.message}`));
    }
    return { session: registry };
  }

  async function stopWorkspace({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const workspace = ctx.state.workspaces[challenge] ?? workspaceRuntime.getWorkspace(challenge);
    const results = {};
    for (const backend of BACKENDS) {
      results[backend] = await stopWorkspaceContainer(challenge, backend);
      const state = workspaceRuntime.backendState(workspace, backend);
      if (state) {
        state.status = "stopped";
        state.updatedAt = nowIso();
        await sessions.disposeBackendRuntime(state, backend);
      }
    }
    workspace.updatedAt = nowIso();
    await ctx.save();
    return {
      stopped: Object.values(results).some(Boolean),
      opencode_stopped: results.opencode,
      codex_stopped: results.codex,
      workspace: workspaceRuntime.workspaceSummary(workspace, await workspaceRuntime.workspaceChallengeInfo(workspace)),
    };
  }

  async function removeWorkspace({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const workspace = ctx.state.workspaces[challenge];
    const results = {};
    for (const backend of BACKENDS) {
      results[backend] = await removeWorkspaceContainer(challenge, backend);
      await removeBackendWorkspaceDir(challenge, backend).catch(() => {});
      await sessions.disposeBackendRuntime(workspace?.backends?.[backend], backend);
    }
    await removeChallengeWorkspaceDirIfEmpty(challenge).catch(() => {});
    delete ctx.state.workspaces[challenge];
    await ctx.save();
    return {
      removed: Object.values(results).some(Boolean),
      opencode_removed: results.opencode,
      codex_removed: results.codex,
    };
  }

  async function resetChallenge({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const info = await workspaceRuntime.challengeInfoForAction(challenge);
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

    const hadWorkspace = Boolean(ctx.state.workspaces[challenge]);
    const workspaceResult = await removeWorkspace({ challenge });
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

  async function startAllChallenges({ mode } = {}) {
    const config = await loadFlagDockConfig();
    await workspaceRuntime.refreshWorkspaceContainerStates(config);
    const challenges = await workspaceRuntime.configuredChallengeList(config);
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
        const result = await startChallenge({ challenge: item.challenge, mode });
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

  async function resetAllChallenges() {
    const config = await loadFlagDockConfig();
    await workspaceRuntime.refreshWorkspaceContainerStates(config);
    const challenges = await workspaceRuntime.configuredChallengeList(config);
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
        const result = await resetChallenge({ challenge: item.challenge });
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

  async function stopAllWorkspaces() {
    const results = [];
    for (const challenge of Object.keys(ctx.state.workspaces).sort()) {
      const result = await stopWorkspace({ challenge });
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

  async function removeAllWorkspaces() {
    const results = [];
    for (const challenge of Object.keys(ctx.state.workspaces).sort()) {
      const result = await removeWorkspace({ challenge });
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

  async function applySolvedWorkspaceAction(action) {
    if (action !== "stop" && action !== "clear") {
      throw new Error(`Invalid workspace action: ${action}`);
    }
    await workspaceRuntime.refreshWorkspaceContainerStates();
    const results = [];
    let changed = 0;
    let unchanged = 0;
    let failed = 0;
    for (const challenge of Object.keys(ctx.state.workspaces).sort()) {
      const workspace = ctx.state.workspaces[challenge];
      if (!workspace) {
        continue;
      }
      let summary = null;
      try {
        const info = await workspaceRuntime.workspaceChallengeInfo(workspace);
        if (!info.solved) {
          continue;
        }
        summary = workspaceRuntime.workspaceSummary(workspace, info);
        const container = [summary.container, summary.codex_container].filter(Boolean).join(",");
        if (action === "stop") {
          const result = await stopWorkspace({ challenge });
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
        await removeWorkspace({ challenge });
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

  async function stopSolvedWorkspaces() {
    return applySolvedWorkspaceAction("stop");
  }

  async function removeSolvedWorkspaces() {
    return applySolvedWorkspaceAction("clear");
  }

  return {
    startChallenge,
    newSession,
    setMode,
    stopWorkspace,
    removeWorkspace,
    resetChallenge,
    startAllChallenges,
    resetAllChallenges,
    stopAllWorkspaces,
    removeAllWorkspaces,
    applySolvedWorkspaceAction,
    stopSolvedWorkspaces,
    removeSolvedWorkspaces,
  };
}

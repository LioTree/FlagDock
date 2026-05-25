import fs from "node:fs/promises";
import { BACKENDS } from "../constants.js";
import { getChallengeInfoAtPath, removeChallengeSolutionStateDirIfEmpty } from "../challenges.js";
import { loadFlagDockConfig } from "../config.js";
import {
  removeBackendWorkspaceDir,
  removeChallengeWorkspaceDirIfEmpty,
  removeWorkspaceContainer,
  stopWorkspaceContainer,
} from "../docker.js";
import { nowIso, pathExists } from "../util.js";
import { backendAdapter } from "./backends/index.js";
import { configuredBackends, validateMode } from "./helpers.js";

export const workspaceActionMethods = {
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
  },

  async newSession({ challenge, mode, backend }) {
    const selectedMode = validateMode(mode, "auto");
    const selectedBackend = await this.resolveActionBackend(backend);
    const { workspace } = await this.prepareChallengeBackends(challenge, [selectedBackend]);
    const registry = await backendAdapter(selectedBackend).createSession(this, workspace, selectedMode);
    await this.save();
    if (selectedMode === "auto") {
      this.driveSession(workspace.challenge, registry.session_id, "initial", selectedBackend)
        .catch((error) => this.log(`${selectedBackend} drive failed: ${error.message}`));
    }
    return { session: registry };
  },

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
  },

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
        await this.disposeBackendRuntime(backendState, backend);
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
  },

  async removeWorkspace({ challenge }) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    const workspace = this.state.workspaces[challenge];
    const results = {};
    for (const backend of BACKENDS) {
      results[backend] = await removeWorkspaceContainer(challenge, backend);
      await removeBackendWorkspaceDir(challenge, backend).catch(() => {});
      await this.disposeBackendRuntime(workspace?.backends?.[backend], backend);
    }
    await removeChallengeWorkspaceDirIfEmpty(challenge).catch(() => {});
    delete this.state.workspaces[challenge];
    await this.save();
    return {
      removed: Object.values(results).some(Boolean),
      opencode_removed: results.opencode,
      codex_removed: results.codex,
    };
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  async stopSolvedWorkspaces() {
    return this.applySolvedWorkspaceAction("stop");
  },

  async removeSolvedWorkspaces() {
    return this.applySolvedWorkspaceAction("clear");
  }
};

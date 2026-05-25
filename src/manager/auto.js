import { nowIso, sleep } from "../util.js";
import { backendAdapter } from "./backends/index.js";
import { AUTO_ERROR_BACKOFF_MS, errorSummary } from "./helpers.js";

export const autoMethods = {
  sessionEntries(workspace) {
    return Object.entries(workspace.backends ?? {}).flatMap(([backend, backendState]) =>
      Object.values(backendState.sessions ?? {}).map((session) => ({ backend, session })),
    );
  },

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
  },

  async interruptAutoSession(workspace, backend, session) {
    return backendAdapter(backend).interruptSession(this, workspace, session);
  },

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
  },

  promptKind(kind) {
    if (kind === "initial" || kind === "writeup") {
      return kind;
    }
    return "continue";
  },

  async driveSession(challenge, sessionID, kind = "continue", backend = "opencode") {
    const key = `${backend}:${challenge}:${sessionID}`;
    if (this.activeAutoLoops.has(key) || this.stopping) {
      return;
    }
    const task = this.runAutoSessionLoop(challenge, sessionID, kind, backend)
      .catch((error) => this.log(`session ${sessionID} auto loop failed: ${error.message}`))
      .finally(() => this.activeAutoLoops.delete(key));
    this.activeAutoLoops.set(key, task);
  },

  async sendAutoPromptTurn(workspace, sessionID, kind, backend) {
    return backendAdapter(backend).sendAutoPromptTurn(this, workspace, sessionID, kind);
  },

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
  },

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
  },

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
};

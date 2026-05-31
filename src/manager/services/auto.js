import { nowIso, sleep } from "../../util.js";
import { normalizeAutoPromptKind } from "../backends/auto-prompt.js";
import { backendAdapter } from "../backends/index.js";
import { AUTO_ERROR_BACKOFF_MS, errorSummary } from "../helpers.js";

export function createAutoService(ctx, { workspaceRuntime, sessions }) {
  const adapterServices = {
    workspaceRuntime,
    sessions,
  };

  function sessionEntries(workspace) {
    return Object.entries(workspace.backends ?? {}).flatMap(([backend, backendState]) =>
      Object.values(backendState.sessions ?? {}).map((session) => ({ backend, session })),
    );
  }

  function clearSolveBroadcastState(workspace) {
    let changed = false;
    if (workspace.solve_event_dispatched_at) {
      delete workspace.solve_event_dispatched_at;
      changed = true;
    }
    for (const { session } of sessionEntries(workspace)) {
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

  async function interruptAutoSession(workspace, backend, session) {
    return backendAdapter(backend).interruptSession(ctx, adapterServices, workspace, session);
  }

  async function dispatchSolvedWorkspace(workspace) {
    if (workspace.solve_event_dispatched_at) {
      return false;
    }
    const activeSessions = sessionEntries(workspace)
      .filter(({ session }) => session.mode === "auto"
        && session.status === "active"
        && !session.writeup_prompt_sent_at
        && session.last_auto_prompt_kind !== "writeup");
    workspace.solve_event_dispatched_at = nowIso();
    workspace.updatedAt = nowIso();
    await ctx.save();
    if (activeSessions.length === 0) {
      await ctx.log(`workspace ${workspace.challenge} solved; no active auto sessions to interrupt`);
      return true;
    }
    await ctx.log(`workspace ${workspace.challenge} solved; interrupting ${activeSessions.length} active auto session(s)`);
    const results = await Promise.allSettled(activeSessions.map(({ backend, session }) => interruptAutoSession(workspace, backend, session)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const { backend, session } = activeSessions[index];
        await ctx.log(`interrupt ${backend}/${session.session_id} failed: ${errorSummary(result.reason)}`);
      }
    }
    return true;
  }

  function driveSession(challenge, sessionID, kind = "continue", backend = "opencode") {
    const key = `${backend}:${challenge}:${sessionID}`;
    if (ctx.activeAutoLoops.has(key) || ctx.stopping) {
      return Promise.resolve();
    }
    const task = runAutoSessionLoop(challenge, sessionID, kind, backend)
      .catch((error) => ctx.log(`session ${sessionID} auto loop failed: ${error.message}`))
      .finally(() => ctx.activeAutoLoops.delete(key));
    ctx.activeAutoLoops.set(key, task);
    return task;
  }

  async function sendAutoPromptTurn(workspace, sessionID, kind, backend) {
    return backendAdapter(backend).sendAutoPromptTurn(ctx, adapterServices, workspace, sessionID, kind);
  }

  async function runAutoSessionLoop(challenge, sessionID, initialKind, backend) {
    let kind = normalizeAutoPromptKind(initialKind);
    let failures = 0;
    while (!ctx.stopping) {
      const workspace = ctx.state.workspaces[challenge];
      const backendState = workspace ? workspaceRuntime.backendState(workspace, backend) : null;
      if (!workspace || !backendState || backendState.status !== "running") {
        return;
      }
      const registry = sessions.sessionRegistry(workspace, backend, sessionID);
      if (!registry || registry.mode !== "auto") {
        return;
      }
      if (registry.status === "active") {
        return;
      }

      const info = await workspaceRuntime.workspaceChallengeInfo(workspace);
      await workspaceRuntime.reconcileSolvedBy(workspace, info);
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
        await sendAutoPromptTurn(workspace, sessionID, kind, backend);
        failures = 0;
        if (kind === "writeup") {
          return;
        }
        if ((await workspaceRuntime.workspaceChallengeInfo(workspace)).solved) {
          return;
        }
        kind = "continue";
      } catch (error) {
        const message = errorSummary(error);
        sessions.updateSessionRegistry(workspace, backend, sessionID, {
          last_error: message,
          status: "unknown",
        });
        await ctx.save();
        await ctx.log(`session ${backend}/${sessionID} ${kind} failed: ${message}`);
        const delay = AUTO_ERROR_BACKOFF_MS[Math.min(failures, AUTO_ERROR_BACKOFF_MS.length - 1)];
        failures += 1;
        await sleep(delay);
      }
    }
  }

  async function maybeDriveWorkspace(workspace) {
    const info = await workspaceRuntime.workspaceChallengeInfo(workspace);
    await workspaceRuntime.reconcileSolvedBy(workspace, info);
    const sessions = sessionEntries(workspace);
    if (!info.solved && clearSolveBroadcastState(workspace)) {
      await ctx.save();
    }
    if (info.solved) {
      await dispatchSolvedWorkspace(workspace);
      for (const { backend, session } of sessions) {
        if (session.mode === "auto" && !session.writeup_prompt_sent_at && session.status !== "active") {
          driveSession(workspace.challenge, session.session_id, "writeup", backend);
        }
      }
      return;
    }
    for (const { backend, session } of sessions) {
      if (session.mode !== "auto" || session.status === "active") {
        continue;
      }
      const kind = session.last_auto_prompt_at ? "continue" : "initial";
      driveSession(workspace.challenge, session.session_id, kind, backend);
      await sleep(20);
    }
  }

  async function tick() {
    if (ctx.stopping) {
      return;
    }
    await workspaceRuntime.refreshWorkspaceContainerStates();
    for (const workspace of Object.values(ctx.state.workspaces)) {
      for (const backend of Object.keys(workspace.backends ?? {})) {
        await workspaceRuntime.syncBackendOutputs(workspace, backend).catch((error) => ctx.log(`sync outputs ${workspace.challenge}/${backend} failed: ${error.message}`));
        await sessions.syncSessions(workspace, backend).catch((error) => ctx.log(`sync ${workspace.challenge}/${backend} failed: ${error.message}`));
      }
      await maybeDriveWorkspace(workspace).catch((error) => ctx.log(`drive ${workspace.challenge} failed: ${error.message}`));
    }
  }

  return {
    sessionEntries,
    clearSolveBroadcastState,
    interruptAutoSession,
    dispatchSolvedWorkspace,
    driveSession,
    sendAutoPromptTurn,
    runAutoSessionLoop,
    maybeDriveWorkspace,
    tick,
  };
}

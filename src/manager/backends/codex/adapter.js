import { CODEX_PORT, DEFAULT_MANAGER_HOST } from "../../../constants.js";
import { CodexAppClient, codexContainerWsUrl, codexHttpUrl, codexWsUrl, waitForCodex } from "./client.js";
import { runDocker, startCodexWorkspaceContainer } from "../../../docker.js";
import { nowIso } from "../../../util.js";
import {
  errorSummary,
  isCodexUnmaterializedThreadError,
  normalizeCodexThreadStatus,
  sessionCollection,
  shellQuote,
} from "../../helpers.js";
import { beginAutoPromptTurn, finishAutoPromptTurn } from "../auto-prompt.js";
import { ensurePrimarySession, managedSessionFields } from "../session-registry.js";

const BACKEND = "codex";
const clientCaches = new WeakMap();

function clientCache(manager) {
  if (!clientCaches.has(manager)) {
    clientCaches.set(manager, new Map());
  }
  return clientCaches.get(manager);
}

function codexAttachSessionName(sessionID) {
  return `codex-${sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
}

async function client(manager, backendState) {
  if (!backendState?.wsUrl) {
    throw new Error("Codex backend has no WebSocket URL");
  }
  const cache = clientCache(manager);
  const cached = cache.get(backendState.wsUrl);
  if (cached) {
    await cached.connect();
    return cached;
  }
  const created = new CodexAppClient(backendState.wsUrl);
  await created.connect();
  cache.set(backendState.wsUrl, created);
  return created;
}

function registerSession(manager, workspace, thread, { role, mode }) {
  const backendState = manager.ensureBackendState(workspace, BACKEND);
  const existing = sessionCollection(backendState)[thread.id] ?? {};
  const registry = {
    session_id: thread.id,
    thread_id: thread.id,
    ...managedSessionFields(BACKEND, workspace, existing, {
      role,
      mode,
      createdAt: thread.createdAt ? new Date(thread.createdAt * 1000).toISOString() : null,
    }),
    status: normalizeCodexThreadStatus(thread.status, false),
    url: backendState.wsUrl ?? "",
    title: existing.title ?? thread.name ?? thread.preview ?? "",
    active_turn_id: existing.active_turn_id,
  };
  sessionCollection(backendState)[thread.id] = registry;
  return registry;
}

function attachTarget(manager, workspace, session) {
  const backendState = manager.backendState(workspace, BACKEND);
  const tmuxSession = codexAttachSessionName(session.session_id);
  const container = backendState.containerName;
  const argv = ["docker", "exec", "-it", container, "tmux", "attach-session", "-t", tmuxSession];
  return {
    challenge: workspace.challenge,
    backend: BACKEND,
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

async function activeTurnID(manager, workspace, session) {
  if (session.active_turn_id) {
    return session.active_turn_id;
  }
  const backendState = manager.backendState(workspace, BACKEND);
  if (!backendState) {
    return null;
  }
  const codexClient = await client(manager, backendState);
  const thread = await codexClient.readThread(session.thread_id);
  const activeTurn = [...(thread?.turns ?? [])].reverse().find((turn) => turn?.status === "inProgress" || turn?.status === "active");
  if (!activeTurn?.id) {
    return null;
  }
  session.active_turn_id = activeTurn.id;
  return activeTurn.id;
}

export const codexBackend = {
  name: BACKEND,
  port: CODEX_PORT,

  urls(config, hostPort) {
    const bindHost = config.workspace.bindHost;
    const internalHost = bindHost === "0.0.0.0" ? DEFAULT_MANAGER_HOST : bindHost;
    return {
      serverUrl: codexHttpUrl(internalHost, hostPort),
      wsUrl: codexWsUrl(internalHost, hostPort),
      attachServerUrl: codexHttpUrl(config.attach.host, hostPort),
    };
  },

  startContainer(manager, workspace, info, config) {
    return startCodexWorkspaceContainer({
      bindHost: config.workspace.bindHost,
      challenge: workspace.challenge,
      challengeDir: info.dir,
      log: (message) => manager.log(message),
    });
  },

  async waitUntilReady(manager, backendState) {
    await waitForCodex(backendState.serverUrl);
    await client(manager, backendState);
  },

  async syncSessions(manager, workspace) {
    const backendState = manager.backendState(workspace, BACKEND);
    if (!backendState) {
      return [];
    }
    if (backendState.status !== "running") {
      return Object.values(sessionCollection(backendState));
    }
    const solved = (await manager.workspaceChallengeInfo(workspace)).solutions[BACKEND].solved;
    const codexClient = await client(manager, backendState);
    for (const session of Object.values(sessionCollection(backendState))) {
      if (!session.thread_id) {
        continue;
      }
      try {
        const thread = await codexClient.readThread(session.thread_id);
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
    await manager.save();
    return Object.values(sessionCollection(backendState));
  },

  async ensurePrimarySession(manager, workspace, mode) {
    return ensurePrimarySession(manager, workspace, BACKEND, mode, async (backendState) => {
      const codexClient = await client(manager, backendState);
      const thread = await codexClient.startThread();
      return registerSession(manager, workspace, thread, { role: "primary", mode });
    });
  },

  async createSession(manager, workspace, mode) {
    const codexClient = await client(manager, manager.backendState(workspace, BACKEND));
    const thread = await codexClient.startThread();
    return registerSession(manager, workspace, thread, {
      role: "auxiliary",
      mode,
    });
  },

  async resolveAttachTarget(manager, workspace, session) {
    const backendState = manager.backendState(workspace, BACKEND);
    if (!backendState || backendState.status !== "running") {
      throw new Error(`Codex workspace ${workspace.challenge} is not running`);
    }
    const target = attachTarget(manager, workspace, session);
    const command = `codex --remote ${codexContainerWsUrl()} resume ${session.thread_id} --no-alt-screen`;
    const hasSession = await runDocker(["exec", backendState.containerName, "tmux", "has-session", "-t", target.tmux_session])
      .then(() => true)
      .catch(() => false);
    if (!hasSession) {
      await runDocker(["exec", backendState.containerName, "tmux", "new-session", "-d", "-s", target.tmux_session, command]);
    }
    return target;
  },

  async interruptSession(manager, workspace, session) {
    const backendState = manager.backendState(workspace, BACKEND);
    if (!backendState) {
      return false;
    }
    const turnID = await activeTurnID(manager, workspace, session);
    if (!turnID) {
      return false;
    }
    const codexClient = await client(manager, backendState);
    await codexClient.interruptTurn(session.thread_id, turnID);
    return true;
  },

  async sendAutoPromptTurn(manager, workspace, sessionID, kind) {
    const backendState = manager.backendState(workspace, BACKEND);
    const session = manager.sessionRegistry(workspace, BACKEND, sessionID);
    if (!backendState || !session) {
      throw new Error(`Codex session ${sessionID} not found`);
    }
    const codexClient = await client(manager, backendState);
    if (session.last_auto_prompt_at) {
      await codexClient.resumeThread(session.thread_id);
    }
    const { promptKind, prompt } = await beginAutoPromptTurn(manager, workspace, BACKEND, sessionID, kind, session);
    const pendingTurn = await codexClient.startTurn(session.thread_id, prompt);
    manager.updateSessionRegistry(workspace, BACKEND, sessionID, {
      active_turn_id: pendingTurn.id,
    });
    await manager.save();
    const turn = await codexClient.waitForTurn(session.thread_id, pendingTurn.id);
    if (turn.status === "failed") {
      throw new Error(`codex turn failed: ${errorSummary(turn.error)}`);
    }
    await finishAutoPromptTurn(manager, workspace, BACKEND, sessionID, {
      active_turn_id: "",
    });
    await this.syncSessions(manager, workspace).catch((error) => manager.log(`sync codex ${workspace.challenge} after ${promptKind} failed: ${error.message}`));
  },

  async dispose(manager, backendState = null) {
    const wsUrl = backendState?.wsUrl ?? null;
    const cache = clientCache(manager);
    if (wsUrl) {
      cache.get(wsUrl)?.dispose();
      cache.delete(wsUrl);
      return;
    }
    for (const cached of cache.values()) {
      cached.dispose();
    }
    cache.clear();
  },
};

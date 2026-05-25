import { AGENT_NAME, CONTAINER_CHALLENGE_DIR, OPENCODE_PORT } from "../../../constants.js";
import { buildWorkspaceUrls } from "../../../config.js";
import { startWorkspaceContainer } from "../../../docker.js";
import { createAttachedRuntime, defaultSessionOptions, listSessionMessages, readSessionInfo, waitForOpenCode } from "./client.js";
import { nowIso } from "../../../util.js";
import {
  agentErrorSummary,
  errorSummary,
  messageErrorSummary,
  normalizeSessionStatus,
  sessionCollection,
  sessionUrl,
} from "../../helpers.js";
import { beginAutoPromptTurn, finishAutoPromptTurn } from "../auto-prompt.js";
import { ensurePrimarySession, managedSessionFields } from "../session-registry.js";

const BACKEND = "opencode";
const runtimeCaches = new WeakMap();
const observerCaches = new WeakMap();

function runtimeCache(manager) {
  if (!runtimeCaches.has(manager)) {
    runtimeCaches.set(manager, new Map());
  }
  return runtimeCaches.get(manager);
}

function observerCache(manager) {
  if (!observerCaches.has(manager)) {
    observerCaches.set(manager, new Map());
  }
  return observerCaches.get(manager);
}

function observerKey(serverUrl, sessionID) {
  return `${serverUrl}\u0000${sessionID}`;
}

async function runtime(manager, backendState) {
  if (!backendState?.serverUrl) {
    throw new Error("OpenCode backend has no server URL");
  }
  const cache = runtimeCache(manager);
  const cached = cache.get(backendState.serverUrl);
  if (cached) {
    return cached;
  }
  const created = await waitForOpenCode(() => createAttachedRuntime(backendState.serverUrl));
  cache.set(backendState.serverUrl, created);
  return created;
}

async function observeSession(manager, workspace, sessionID) {
  const backendState = manager.backendState(workspace, BACKEND);
  if (!backendState?.serverUrl || backendState.status !== "running" || manager.stopping) {
    return;
  }
  const observers = observerCache(manager);
  const key = observerKey(backendState.serverUrl, sessionID);
  if (observers.has(key)) {
    return;
  }
  const openCodeRuntime = await runtime(manager, backendState);
  const entry = {
    challenge: workspace.challenge,
    serverUrl: backendState.serverUrl,
    sessionID,
    stop: () => {},
  };
  const task = (async () => {
    let observer = null;
    try {
      observer = await openCodeRuntime.observeSession({
        includeSubagents: true,
        resolveFinalResult: true,
        sessionID,
        untilIdle: true,
      });
      entry.stop = () => observer.stop();
      for await (const event of observer.receiveResponse()) {
        const currentWorkspace = manager.state.workspaces[entry.challenge];
        const registry = currentWorkspace ? manager.sessionRegistry(currentWorkspace, BACKEND, entry.sessionID) : null;
        if (!currentWorkspace || !registry || manager.stopping) {
          observer.stop();
          break;
        }
        if (event.type === "status") {
          const nextValues = {
            last_seen_at: nowIso(),
          };
          if (event.status === "busy" || event.status === "retry") {
            nextValues.status = "active";
          }
          manager.updateSessionRegistry(currentWorkspace, BACKEND, entry.sessionID, nextValues);
          await manager.save();
          continue;
        }
        if (event.type === "error") {
          manager.updateSessionRegistry(currentWorkspace, BACKEND, entry.sessionID, {
            last_error: agentErrorSummary(event.error),
            last_seen_at: nowIso(),
          });
          await manager.save();
          continue;
        }
        if (event.type === "result") {
          await manager.syncBackendOutputs(currentWorkspace, BACKEND);
          const solved = (await manager.workspaceChallengeInfo(currentWorkspace)).solutions[BACKEND].solved;
          await manager.reconcileSolvedBy(currentWorkspace);
          manager.updateSessionRegistry(currentWorkspace, BACKEND, entry.sessionID, {
            last_error: event.result.error ? agentErrorSummary(event.result.error) : "",
            last_response_at: nowIso(),
            last_seen_at: nowIso(),
            status: solved ? "completed" : "idle",
          });
          await manager.save();
        }
      }
    } catch (error) {
      await manager.log(`observe opencode ${entry.challenge}/${entry.sessionID} failed: ${errorSummary(error)}`);
    } finally {
      observer?.stop();
      observers.delete(key);
    }
  })();
  entry.task = task;
  observers.set(key, entry);
}

function registerSession(manager, workspace, sessionID, { role, mode }) {
  const backendState = manager.ensureBackendState(workspace, BACKEND);
  const existing = sessionCollection(backendState)[sessionID] ?? {};
  const registry = {
    session_id: sessionID,
    ...managedSessionFields(BACKEND, workspace, existing, { role, mode }),
    status: existing.status ?? "unknown",
    url: sessionUrl(backendState.attachServerUrl ?? backendState.serverUrl, sessionID),
    title: existing.title ?? "",
  };
  sessionCollection(backendState)[sessionID] = registry;
  return registry;
}

export const opencodeBackend = {
  name: BACKEND,
  port: OPENCODE_PORT,

  urls(config, hostPort) {
    return buildWorkspaceUrls(config, hostPort);
  },

  startContainer(manager, workspace, info, config) {
    return startWorkspaceContainer({
      bindHost: config.workspace.bindHost,
      challenge: workspace.challenge,
      challengeDir: info.dir,
      log: (message) => manager.log(message),
    });
  },

  async waitUntilReady(manager, backendState) {
    await runtime(manager, backendState);
  },

  async syncSessions(manager, workspace) {
    const backendState = manager.backendState(workspace, BACKEND);
    if (!backendState) {
      return [];
    }
    if (backendState.status !== "running") {
      return Object.values(sessionCollection(backendState));
    }
    const openCodeRuntime = await runtime(manager, backendState);
    const sessions = await openCodeRuntime.listSessions(200);
    const sessionIDs = new Set(sessions.map((session) => session.sessionID));
    const solved = (await manager.workspaceChallengeInfo(workspace)).solutions[BACKEND].solved;
    for (const session of sessions) {
      const existing = sessionCollection(backendState)[session.sessionID] ?? {};
      const sessionInfo = await readSessionInfo(openCodeRuntime, session.sessionID).catch(() => null);
      const registry = {
        backend: BACKEND,
        session_id: session.sessionID,
        challenge: workspace.challenge,
        directory: CONTAINER_CHALLENGE_DIR,
        role: session.sessionID === backendState.primarySessionId ? "primary" : (existing.role ?? "auxiliary"),
        source: existing.source ?? "discovered",
        mode: existing.mode ?? "manual",
        created_at: existing.created_at ?? new Date(session.createTime).toISOString(),
        last_seen_at: nowIso(),
        status: normalizeSessionStatus(session.status, solved, Boolean(sessionInfo?.time?.archived)),
        url: sessionUrl(backendState.attachServerUrl ?? backendState.serverUrl, session.sessionID),
        title: session.title ?? "",
        last_auto_prompt_at: existing.last_auto_prompt_at,
        last_auto_prompt_kind: existing.last_auto_prompt_kind,
        last_response_at: existing.last_response_at,
        writeup_prompt_sent_at: existing.writeup_prompt_sent_at,
        last_error: existing.last_error ?? "",
      };
      try {
        if (registry.status !== "active") {
          const messages = await listSessionMessages(openCodeRuntime, session.sessionID, 10);
          const latestError = [...messages].reverse().map(messageErrorSummary).find(Boolean);
          registry.last_error = latestError ?? "";
        }
      } catch {
        registry.last_error = existing.last_error ?? "";
      }
      sessionCollection(backendState)[session.sessionID] = registry;
      if (registry.status === "active") {
        observeSession(manager, workspace, session.sessionID)
          .catch((error) => manager.log(`observe ${workspace.challenge}/${session.sessionID} failed: ${error.message}`));
      }
    }
    for (const session of Object.values(sessionCollection(backendState))) {
      if (!sessionIDs.has(session.session_id) && session.status !== "closed") {
        session.status = "unknown";
      }
    }
    await manager.save();
    return Object.values(sessionCollection(backendState));
  },

  async ensurePrimarySession(manager, workspace, mode) {
    return ensurePrimarySession(manager, workspace, BACKEND, mode, async (backendState) => {
      const openCodeRuntime = await runtime(manager, backendState);
      const session = await openCodeRuntime.createSession(defaultSessionOptions());
      return registerSession(manager, workspace, session.id, { role: "primary", mode });
    });
  },

  async createSession(manager, workspace, mode) {
    const openCodeRuntime = await runtime(manager, manager.backendState(workspace, BACKEND));
    const session = await openCodeRuntime.createSession(defaultSessionOptions());
    return registerSession(manager, workspace, session.id, {
      role: "auxiliary",
      mode,
    });
  },

  resolveAttachTarget(manager, workspace, session) {
    return {
      challenge: workspace.challenge,
      backend: BACKEND,
      session: session.session_id,
      role: session.role ?? "",
      status: session.status ?? "",
      url: session.url,
      command: session.url,
    };
  },

  async interruptSession(manager, workspace, session) {
    const backendState = manager.backendState(workspace, BACKEND);
    if (!backendState) {
      return false;
    }
    const openCodeRuntime = await runtime(manager, backendState);
    const opened = await openCodeRuntime.openSession(session.session_id, defaultSessionOptions());
    await opened.interrupt();
    return true;
  },

  async sendAutoPromptTurn(manager, workspace, sessionID, kind) {
    const backendState = manager.backendState(workspace, BACKEND);
    const openCodeRuntime = await runtime(manager, backendState);
    const session = await openCodeRuntime.openSession(sessionID, { agent: AGENT_NAME });
    const { promptKind, prompt } = await beginAutoPromptTurn(manager, workspace, BACKEND, sessionID, kind);
    const result = await session.runAgent(prompt, { agent: AGENT_NAME });
    if (result?.error) {
      throw new Error(`agent turn failed: ${errorSummary(result.error)}`);
    }
    await finishAutoPromptTurn(manager, workspace, BACKEND, sessionID);
    await this.syncSessions(manager, workspace).catch((error) => manager.log(`sync ${workspace.challenge} after ${promptKind} failed: ${error.message}`));
  },

  async dispose(manager, backendState = null) {
    const serverUrl = backendState?.serverUrl ?? null;
    const observers = observerCache(manager);
    for (const [key, observer] of observers.entries()) {
      if (!serverUrl || observer.serverUrl === serverUrl) {
        observer.stop();
        observers.delete(key);
      }
    }
    const cache = runtimeCache(manager);
    if (serverUrl) {
      const cached = cache.get(serverUrl);
      await cached?.dispose().catch(() => {});
      cache.delete(serverUrl);
      return;
    }
    for (const cached of cache.values()) {
      await cached?.dispose().catch(() => {});
    }
    cache.clear();
  },
};

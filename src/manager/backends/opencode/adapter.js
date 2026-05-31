import { AGENT_NAME, CONTAINER_CHALLENGE_DIR, OPENCODE_PORT } from "../../../constants.js";
import { buildWorkspaceUrls } from "../../../config.js";
import { startWorkspaceContainer } from "../../../docker.js";
import { nowIso } from "../../../util.js";
import { beginAutoPromptTurn, finishAutoPromptTurn } from "../auto-prompt.js";
import { ensurePrimarySession, managedSessionFields } from "../session-registry.js";
import { createAttachedRuntime, defaultSessionOptions, listSessionMessages, readSessionInfo, waitForOpenCode } from "./client.js";
import {
  agentErrorSummary,
  errorSummary,
  messageErrorSummary,
  normalizeSessionStatus,
  sessionCollection,
  sessionUrl,
} from "../../helpers.js";

const BACKEND = "opencode";
const runtimeCaches = new WeakMap();
const observerCaches = new WeakMap();

function runtimeCache(context) {
  if (!runtimeCaches.has(context)) {
    runtimeCaches.set(context, new Map());
  }
  return runtimeCaches.get(context);
}

function observerCache(context) {
  if (!observerCaches.has(context)) {
    observerCaches.set(context, new Map());
  }
  return observerCaches.get(context);
}

function observerKey(serverUrl, sessionID) {
  return `${serverUrl}\u0000${sessionID}`;
}

async function runtime(context, backendState) {
  if (!backendState?.serverUrl) {
    throw new Error("OpenCode backend has no server URL");
  }
  const cache = runtimeCache(context);
  const cached = cache.get(backendState.serverUrl);
  if (cached) {
    return cached;
  }
  const created = await waitForOpenCode(() => createAttachedRuntime(backendState.serverUrl));
  cache.set(backendState.serverUrl, created);
  return created;
}

async function observeSession(context, services, workspace, sessionID) {
  const { workspaceRuntime, sessions } = services;
  const backendState = workspaceRuntime.backendState(workspace, BACKEND);
  if (!backendState?.serverUrl || backendState.status !== "running" || context.stopping) {
    return;
  }
  const observers = observerCache(context);
  const key = observerKey(backendState.serverUrl, sessionID);
  if (observers.has(key)) {
    return;
  }
  const openCodeRuntime = await runtime(context, backendState);
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
        const currentWorkspace = context.state.workspaces[entry.challenge];
        const registry = currentWorkspace ? sessions.sessionRegistry(currentWorkspace, BACKEND, entry.sessionID) : null;
        if (!currentWorkspace || !registry || context.stopping) {
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
          sessions.updateSessionRegistry(currentWorkspace, BACKEND, entry.sessionID, nextValues);
          await context.save();
          continue;
        }
        if (event.type === "error") {
          sessions.updateSessionRegistry(currentWorkspace, BACKEND, entry.sessionID, {
            last_error: agentErrorSummary(event.error),
            last_seen_at: nowIso(),
          });
          await context.save();
          continue;
        }
        if (event.type === "result") {
          await workspaceRuntime.syncBackendOutputs(currentWorkspace, BACKEND);
          const solved = (await workspaceRuntime.workspaceChallengeInfo(currentWorkspace)).solutions[BACKEND].solved;
          await workspaceRuntime.reconcileSolvedBy(currentWorkspace);
          sessions.updateSessionRegistry(currentWorkspace, BACKEND, entry.sessionID, {
            last_error: event.result.error ? agentErrorSummary(event.result.error) : "",
            last_response_at: nowIso(),
            last_seen_at: nowIso(),
            status: solved ? "completed" : "idle",
          });
          await context.save();
        }
      }
    } catch (error) {
      await context.log(`observe opencode ${entry.challenge}/${entry.sessionID} failed: ${errorSummary(error)}`);
    } finally {
      observer?.stop();
      observers.delete(key);
    }
  })();
  entry.task = task;
  observers.set(key, entry);
}

function registerSession(workspaceRuntime, workspace, sessionID, { role, mode }) {
  const backendState = workspaceRuntime.ensureBackendState(workspace, BACKEND);
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

  startContainer(context, workspace, info, config) {
    return startWorkspaceContainer({
      bindHost: config.workspace.bindHost,
      challenge: workspace.challenge,
      challengeDir: info.dir,
      log: (message) => context.log(message),
    });
  },

  async waitUntilReady(context, backendState) {
    await runtime(context, backendState);
  },

  async syncSessions(context, services, workspace) {
    const { workspaceRuntime } = services;
    const backendState = workspaceRuntime.backendState(workspace, BACKEND);
    if (!backendState) {
      return [];
    }
    if (backendState.status !== "running") {
      return Object.values(sessionCollection(backendState));
    }
    const openCodeRuntime = await runtime(context, backendState);
    const sessions = await openCodeRuntime.listSessions(200);
    const sessionIDs = new Set(sessions.map((session) => session.sessionID));
    const solved = (await workspaceRuntime.workspaceChallengeInfo(workspace)).solutions[BACKEND].solved;
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
        observeSession(context, services, workspace, session.sessionID)
          .catch((error) => context.log(`observe ${workspace.challenge}/${session.sessionID} failed: ${error.message}`));
      }
    }
    for (const session of Object.values(sessionCollection(backendState))) {
      if (!sessionIDs.has(session.session_id) && session.status !== "closed") {
        session.status = "unknown";
      }
    }
    await context.save();
    return Object.values(sessionCollection(backendState));
  },

  async ensurePrimarySession(context, services, workspace, mode) {
    const { workspaceRuntime } = services;
    return ensurePrimarySession(workspaceRuntime, workspace, BACKEND, mode, async (backendState) => {
      const openCodeRuntime = await runtime(context, backendState);
      const session = await openCodeRuntime.createSession(defaultSessionOptions());
      return registerSession(workspaceRuntime, workspace, session.id, { role: "primary", mode });
    });
  },

  async createSession(context, services, workspace, mode) {
    const { workspaceRuntime } = services;
    const openCodeRuntime = await runtime(context, workspaceRuntime.backendState(workspace, BACKEND));
    const session = await openCodeRuntime.createSession(defaultSessionOptions());
    return registerSession(workspaceRuntime, workspace, session.id, {
      role: "auxiliary",
      mode,
    });
  },

  resolveAttachTarget(_context, _services, workspace, session) {
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

  async interruptSession(context, services, workspace, session) {
    const backendState = services.workspaceRuntime.backendState(workspace, BACKEND);
    if (!backendState) {
      return false;
    }
    const openCodeRuntime = await runtime(context, backendState);
    const opened = await openCodeRuntime.openSession(session.session_id, defaultSessionOptions());
    await opened.interrupt();
    return true;
  },

  async sendAutoPromptTurn(context, services, workspace, sessionID, kind) {
    const backendState = services.workspaceRuntime.backendState(workspace, BACKEND);
    const openCodeRuntime = await runtime(context, backendState);
    const session = await openCodeRuntime.openSession(sessionID, { agent: AGENT_NAME });
    const { promptKind, prompt } = await beginAutoPromptTurn(context, services, workspace, BACKEND, sessionID, kind);
    const result = await session.runAgent(prompt, { agent: AGENT_NAME });
    if (result?.error) {
      throw new Error(`agent turn failed: ${errorSummary(result.error)}`);
    }
    await finishAutoPromptTurn(context, services, workspace, BACKEND, sessionID);
    await this.syncSessions(context, services, workspace).catch((error) => context.log(`sync ${workspace.challenge} after ${promptKind} failed: ${error.message}`));
  },

  async dispose(context, backendState = null) {
    const serverUrl = backendState?.serverUrl ?? null;
    const observers = observerCache(context);
    for (const [key, observer] of observers.entries()) {
      if (!serverUrl || observer.serverUrl === serverUrl) {
        observer.stop();
        observers.delete(key);
      }
    }
    const cache = runtimeCache(context);
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

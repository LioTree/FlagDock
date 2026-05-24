import { CONTAINER_CHALLENGE_DIR } from "../constants.js";
import { codexContainerWsUrl } from "../codex.js";
import { runDocker } from "../docker.js";
import { defaultSessionOptions, listSessionMessages, readSessionInfo } from "../opencode.js";
import { nowIso } from "../util.js";
import {
  agentErrorSummary,
  codexAttachSessionName,
  errorSummary,
  isCodexUnmaterializedThreadError,
  messageErrorSummary,
  normalizeCodexThreadStatus,
  normalizeSessionStatus,
  sessionCollection,
  sessionUrl,
  shellQuote,
  validateBackend,
} from "./helpers.js";

export const sessionMethods = {
  openCodeObserverKey(serverUrl, sessionID) {
    return `${serverUrl}\u0000${sessionID}`;
  },

  stopOpenCodeObservers(serverUrl = null) {
    for (const observer of this.openCodeObservers.values()) {
      if (!serverUrl || observer.serverUrl === serverUrl) {
        observer.stop();
      }
    }
  },

  async observeOpenCodeSession(workspace, sessionID) {
    const backendState = this.backendState(workspace, "opencode");
    if (!backendState?.serverUrl || backendState.status !== "running" || this.stopping) {
      return;
    }
    const key = this.openCodeObserverKey(backendState.serverUrl, sessionID);
    if (this.openCodeObservers.has(key)) {
      return;
    }
    const runtime = await this.getRuntime(backendState);
    const entry = {
      challenge: workspace.challenge,
      serverUrl: backendState.serverUrl,
      sessionID,
      stop: () => {},
    };
    const task = (async () => {
      let observer = null;
      try {
        observer = await runtime.observeSession({
          includeSubagents: true,
          resolveFinalResult: true,
          sessionID,
          untilIdle: true,
        });
        entry.stop = () => observer.stop();
        for await (const event of observer.receiveResponse()) {
          const currentWorkspace = this.state.workspaces[entry.challenge];
          const registry = currentWorkspace ? this.sessionRegistry(currentWorkspace, "opencode", entry.sessionID) : null;
          if (!currentWorkspace || !registry || this.stopping) {
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
            this.updateSessionRegistry(currentWorkspace, "opencode", entry.sessionID, nextValues);
            await this.save();
            continue;
          }
          if (event.type === "error") {
            this.updateSessionRegistry(currentWorkspace, "opencode", entry.sessionID, {
              last_error: agentErrorSummary(event.error),
              last_seen_at: nowIso(),
            });
            await this.save();
            continue;
          }
          if (event.type === "result") {
            await this.syncBackendOutputs(currentWorkspace, "opencode");
            const solved = (await this.workspaceChallengeInfo(currentWorkspace)).solutions.opencode.solved;
            await this.reconcileSolvedBy(currentWorkspace);
            this.updateSessionRegistry(currentWorkspace, "opencode", entry.sessionID, {
              last_error: event.result.error ? agentErrorSummary(event.result.error) : "",
              last_response_at: nowIso(),
              last_seen_at: nowIso(),
              status: solved ? "completed" : "idle",
            });
            await this.save();
          }
        }
      } catch (error) {
        await this.log(`observe opencode ${entry.challenge}/${entry.sessionID} failed: ${errorSummary(error)}`);
      } finally {
        observer?.stop();
        this.openCodeObservers.delete(key);
      }
    })();
    entry.task = task;
    this.openCodeObservers.set(key, entry);
  },

  async syncOpenCodeSessions(workspace) {
    const backendState = this.backendState(workspace, "opencode");
    if (!backendState) {
      return [];
    }
    if (backendState.status !== "running") {
      return Object.values(sessionCollection(backendState));
    }
    const runtime = await this.getRuntime(backendState);
    const sessions = await runtime.listSessions(200);
    const sessionIDs = new Set(sessions.map((session) => session.sessionID));
    const solved = (await this.workspaceChallengeInfo(workspace)).solutions.opencode.solved;
    for (const session of sessions) {
      const existing = sessionCollection(backendState)[session.sessionID] ?? {};
      const sessionInfo = await readSessionInfo(runtime, session.sessionID).catch(() => null);
      const registry = {
        backend: "opencode",
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
          const messages = await listSessionMessages(runtime, session.sessionID, 10);
          const latestError = [...messages].reverse().map(messageErrorSummary).find(Boolean);
          registry.last_error = latestError ?? "";
        }
      } catch {
        registry.last_error = existing.last_error ?? "";
      }
      sessionCollection(backendState)[session.sessionID] = registry;
      if (registry.status === "active") {
        this.observeOpenCodeSession(workspace, session.sessionID)
          .catch((error) => this.log(`observe ${workspace.challenge}/${session.sessionID} failed: ${error.message}`));
      }
    }
    for (const session of Object.values(sessionCollection(backendState))) {
      if (!sessionIDs.has(session.session_id) && session.status !== "closed") {
        session.status = "unknown";
      }
    }
    await this.save();
    return Object.values(sessionCollection(backendState));
  },

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
  },

  async syncSessions(workspace, backend) {
    validateBackend(backend);
    if (backend === "codex") {
      return this.syncCodexSessions(workspace);
    }
    return this.syncOpenCodeSessions(workspace);
  },

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
  },

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
  },

  sessionRegistry(workspace, backend, sessionID) {
    return this.backendState(workspace, backend)?.sessions?.[sessionID] ?? null;
  },

  updateSessionRegistry(workspace, backend, sessionID, values) {
    const registry = this.sessionRegistry(workspace, backend, sessionID);
    if (!registry) {
      return null;
    }
    Object.assign(registry, values);
    return registry;
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  async resolveAttachTarget(workspace, backend, session) {
    if (backend === "codex") {
      return this.attachCodex(workspace, session);
    }
    return this.attachTarget(workspace, backend, session);
  },

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
  },

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
  },

  async disposeBackendRuntime(backendState) {
    if (!backendState) {
      return;
    }
    if (backendState.serverUrl) {
      this.stopOpenCodeObservers(backendState.serverUrl);
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
};

import { backendAdapter } from "./backends/index.js";
import { validateBackend } from "./helpers.js";

export const sessionMethods = {
  async syncSessions(workspace, backend) {
    return backendAdapter(backend).syncSessions(this, workspace);
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
    return backendAdapter(backend).ensurePrimarySession(this, workspace, mode);
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

  async resolveAttachTarget(workspace, backend, session) {
    return backendAdapter(backend).resolveAttachTarget(this, workspace, session);
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

  async disposeBackendRuntime(backendState, backend = null) {
    if (!backendState) {
      return;
    }
    await backendAdapter(backend ?? backendState.backend).dispose(this, backendState);
  }
};

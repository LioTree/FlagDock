import { backendAdapter } from "../backends/index.js";
import { validateBackend } from "../helpers.js";

export function createSessionService(ctx, { workspaceRuntime }) {
  const adapterServices = {
    workspaceRuntime,
    sessions: null,
  };

  async function syncSessions(workspace, backend) {
    return backendAdapter(backend).syncSessions(ctx, adapterServices, workspace);
  }

  function sessionRegistry(workspace, backend, sessionID) {
    return workspaceRuntime.backendState(workspace, backend)?.sessions?.[sessionID] ?? null;
  }

  function updateSessionRegistry(workspace, backend, sessionID, values) {
    const registry = sessionRegistry(workspace, backend, sessionID);
    if (!registry) {
      return null;
    }
    Object.assign(registry, values);
    return registry;
  }

  async function ensurePrimarySession(workspace, backend, mode) {
    return backendAdapter(backend).ensurePrimarySession(ctx, adapterServices, workspace, mode);
  }

  async function listSessions(challenge, backend = null) {
    if (!challenge) {
      throw new Error("challenge is required");
    }
    if (backend) {
      validateBackend(backend);
    }
    const workspace = ctx.state.workspaces[challenge];
    if (!workspace) {
      return [];
    }
    await workspaceRuntime.refreshWorkspaceContainerState(workspace);
    const selectedBackends = backend ? [backend] : Object.keys(workspace.backends ?? {});
    const sessions = [];
    for (const item of selectedBackends) {
      if (!workspaceRuntime.backendState(workspace, item)) {
        continue;
      }
      await syncSessions(workspace, item);
      sessions.push(...Object.values(workspaceRuntime.backendState(workspace, item).sessions ?? {}).map((session) => ({ backend: item, ...session })));
    }
    return sessions.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async function resolveAttachTarget(workspace, backend, session) {
    return backendAdapter(backend).resolveAttachTarget(ctx, adapterServices, workspace, session);
  }

  async function listAttachTargets(challenge = null, backend = null) {
    if (backend) {
      validateBackend(backend);
    }
    const workspaces = challenge
      ? [ctx.state.workspaces[challenge]].filter(Boolean)
      : Object.values(ctx.state.workspaces);
    const rows = [];
    for (const workspace of workspaces) {
      await workspaceRuntime.refreshWorkspaceContainerState(workspace);
      const selectedBackends = backend ? [backend] : Object.keys(workspace.backends ?? {});
      for (const item of selectedBackends) {
        const backendState = workspaceRuntime.backendState(workspace, item);
        if (!backendState) {
          continue;
        }
        await syncSessions(workspace, item);
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
          const target = await resolveAttachTarget(workspace, item, session);
          rows.push({ ...base, attach: target.command ?? target.url ?? "", url: target.url ?? "", command: target.command ?? "" });
        }
      }
    }
    return rows.sort((a, b) =>
      a.challenge.localeCompare(b.challenge)
      || a.backend.localeCompare(b.backend)
      || a.session.localeCompare(b.session),
    );
  }

  async function attach(challenge, sessionID, backend = null) {
    if (!challenge) {
      return { mode: "list", attach: await listAttachTargets(null, backend) };
    }
    const workspace = ctx.state.workspaces[challenge];
    if (!workspace) {
      if (backend || sessionID) {
        throw new Error(`Workspace ${challenge} is not running`);
      }
      return { mode: "list", attach: [] };
    }
    await workspaceRuntime.refreshWorkspaceContainerState(workspace);

    if (!backend && !sessionID) {
      return { mode: "list", attach: await listAttachTargets(challenge) };
    }

    let selectedBackend = backend ? validateBackend(backend) : null;
    if (!selectedBackend && sessionID) {
      const matches = [];
      for (const item of Object.keys(workspace.backends ?? {})) {
        const backendState = workspaceRuntime.backendState(workspace, item);
        if (!backendState) {
          continue;
        }
        await syncSessions(workspace, item);
        if (backendState.sessions?.[sessionID]) {
          matches.push(item);
        }
      }
      if (matches.length > 1) {
        throw new Error(`Session ${sessionID} exists in multiple backends; pass --backend`);
      }
      selectedBackend = matches[0] ?? await workspaceRuntime.resolveActionBackend(null);
    }

    const backendState = workspaceRuntime.backendState(workspace, selectedBackend);
    if (!backendState || backendState.status !== "running") {
      throw new Error(`${selectedBackend} workspace ${challenge} is not running`);
    }
    await syncSessions(workspace, selectedBackend);
    const selected = sessionID || backendState.primarySessionId;
    const session = selected ? backendState.sessions?.[selected] : null;
    if (!selected || !session) {
      throw new Error(`Session not found for ${challenge}`);
    }
    return { mode: "target", ...await resolveAttachTarget(workspace, selectedBackend, session) };
  }

  async function disposeBackendRuntime(backendState, backend = null) {
    if (!backendState) {
      return;
    }
    await backendAdapter(backend ?? backendState.backend).dispose(ctx, backendState);
  }

  const sessionService = {
    syncSessions,
    sessionRegistry,
    updateSessionRegistry,
    ensurePrimarySession,
    listSessions,
    resolveAttachTarget,
    listAttachTargets,
    attach,
    disposeBackendRuntime,
  };

  adapterServices.sessions = sessionService;
  return sessionService;
}

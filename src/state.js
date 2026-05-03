import { BACKENDS, DAEMON_PATH, STATE_PATH } from "./constants.js";
import { readJson, writeJson } from "./util.js";

export function createEmptyState() {
  return {
    version: 2,
    workspaces: {},
  };
}

function migrateWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") {
    return workspace;
  }
  if (workspace.backends && typeof workspace.backends === "object") {
    for (const backend of BACKENDS) {
      if (workspace.backends[backend]) {
        workspace.backends[backend].sessions ??= {};
      }
    }
    return workspace;
  }

  const backends = {};
  if (workspace.containerName || workspace.serverUrl || workspace.attachServerUrl || workspace.sessions) {
    backends.opencode = {
      backend: "opencode",
      containerName: workspace.containerName,
      hostPort: workspace.hostPort,
      status: workspace.status,
      challengeDir: workspace.challengeDir,
      serverUrl: workspace.serverUrl,
      attachServerUrl: workspace.attachServerUrl,
      primarySessionId: workspace.primarySessionId,
      sessions: workspace.sessions ?? {},
      updatedAt: workspace.updatedAt,
    };
  }
  if (workspace.codex) {
    backends.codex = {
      ...workspace.codex,
      backend: "codex",
      sessions: workspace.codex.sessions ?? {},
    };
  }

  return {
    challenge: workspace.challenge,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    solvedBy: workspace.solvedBy,
    backends,
  };
}

export async function loadState() {
  const loaded = await readJson(STATE_PATH, createEmptyState());
  const workspaces = Object.fromEntries(
    Object.entries(loaded.workspaces ?? {}).map(([challenge, workspace]) => [challenge, migrateWorkspace(workspace)]),
  );
  return {
    ...createEmptyState(),
    ...loaded,
    version: 2,
    workspaces,
  };
}

export async function saveState(state) {
  await writeJson(STATE_PATH, state);
}

export async function loadDaemonInfo() {
  return readJson(DAEMON_PATH, null);
}

export async function saveDaemonInfo(info) {
  await writeJson(DAEMON_PATH, info);
}

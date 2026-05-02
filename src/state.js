import { DAEMON_PATH, STATE_PATH } from "./constants.js";
import { readJson, writeJson } from "./util.js";

export function createEmptyState() {
  return {
    version: 1,
    workspaces: {},
  };
}

export async function loadState() {
  const loaded = await readJson(STATE_PATH, createEmptyState());
  return {
    ...createEmptyState(),
    ...loaded,
    workspaces: loaded.workspaces ?? {},
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

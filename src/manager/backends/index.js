import { validateBackend } from "../helpers.js";
import { codexBackend } from "./codex/adapter.js";
import { opencodeBackend } from "./opencode/adapter.js";

export const backendAdapters = {
  opencode: opencodeBackend,
  codex: codexBackend,
};

export function backendAdapter(backend) {
  return backendAdapters[validateBackend(backend)];
}

export async function disposeBackendAdapters(manager) {
  await Promise.all(Object.values(backendAdapters).map((adapter) => adapter.dispose(manager)));
}

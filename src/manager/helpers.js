import { BACKENDS, CODEX_PORT, CONTAINER_CHALLENGE_DIR, OPENCODE_PORT } from "../constants.js";
import { attachDirectorySegment, nowIso } from "../util.js";

export const DEFAULT_MODE = "auto";
export const VALID_MODES = new Set(["auto", "manual"]);
export const VALID_BACKENDS = new Set(BACKENDS);
export const AUTO_ERROR_BACKOFF_MS = [15000, 30000, 60000, 120000, 300000];

export function validateMode(mode, fallback = DEFAULT_MODE) {
  const selected = mode ?? fallback;
  if (!VALID_MODES.has(selected)) {
    throw new Error(`Invalid mode: ${selected}`);
  }
  return selected;
}

export function validateBackend(backend) {
  if (!VALID_BACKENDS.has(backend)) {
    throw new Error(`Invalid backend: ${backend}`);
  }
  return backend;
}

export function configuredBackends(mode) {
  return mode === "race" ? [...BACKENDS] : [validateBackend(mode)];
}

export function backendPort(backend) {
  return backend === "codex" ? CODEX_PORT : OPENCODE_PORT;
}

export function normalizeSessionStatus(status, solved, archived = false) {
  if (archived) {
    return "closed";
  }
  if (status === "busy" || status === "retry") {
    return "active";
  }
  if (solved && (status === "idle" || status === "unknown" || !status)) {
    return "completed";
  }
  if (status === "idle" || status === "unknown" || !status) {
    return "idle";
  }
  return "unknown";
}

export function normalizeCodexThreadStatus(status, solved) {
  if (status?.type === "active") {
    return "active";
  }
  if (status?.type === "idle") {
    return solved ? "completed" : "idle";
  }
  if (status?.type === "systemError") {
    return "unknown";
  }
  return solved ? "completed" : "unknown";
}

export function sessionUrl(baseUrl, sessionID) {
  return `${baseUrl}/${attachDirectorySegment(CONTAINER_CHALLENGE_DIR)}/session/${sessionID}`;
}

export function codexAttachSessionName(sessionID) {
  return `codex-${sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function messageErrorSummary(message) {
  const error = message?.info?.error;
  if (!error) {
    return "";
  }
  return agentErrorSummary(error);
}

export function agentErrorSummary(error) {
  if (!error) {
    return "";
  }
  const name = error.name ?? "Error";
  const detail = error.data?.message ?? error.message ?? JSON.stringify(error);
  return `${name}: ${detail}`;
}

export function errorSummary(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error) ?? String(error);
}

export function isCodexUnmaterializedThreadError(error) {
  return errorSummary(error).includes(" is not materialized");
}

export function emptyBackendState(backend) {
  return {
    backend,
    status: "available",
    sessions: {},
    updatedAt: nowIso(),
  };
}

export function sessionCollection(backendState) {
  backendState.sessions ??= {};
  return backendState.sessions;
}

import fs from "node:fs/promises";
import { parse } from "yaml";
import { FLAGDOCK_CONFIG_FILE } from "./constants.js";

const DEFAULT_BIND_HOST = "127.0.0.1";
const VALID_BACKEND_MODES = new Set(["opencode", "codex", "race"]);

function readString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function rejectUrlLikeHost(name, value) {
  if (value.includes("://") || value.includes("/")) {
    throw new Error(`${name} must be a host or IP address, not a URL`);
  }
  return value;
}

function readBackendMode(value) {
  const mode = typeof value === "string" && value.trim() ? value.trim() : "opencode";
  if (!VALID_BACKEND_MODES.has(mode)) {
    throw new Error(`backend.mode must be one of: ${[...VALID_BACKEND_MODES].join(", ")}`);
  }
  return mode;
}

export async function loadFlagDockConfig() {
  let parsed = {};
  try {
    const raw = await fs.readFile(FLAGDOCK_CONFIG_FILE, "utf8");
    parsed = parse(raw) ?? {};
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const workspace = parsed.workspace && typeof parsed.workspace === "object" ? parsed.workspace : {};
  const attach = parsed.attach && typeof parsed.attach === "object" ? parsed.attach : {};
  const backend = parsed.backend && typeof parsed.backend === "object" ? parsed.backend : {};
  const bindHost = rejectUrlLikeHost("workspace.bindHost", readString(workspace.bindHost, DEFAULT_BIND_HOST));
  const attachHost = rejectUrlLikeHost("attach.host", readString(attach.host, bindHost));
  const backendMode = readBackendMode(backend.mode);

  return {
    workspace: {
      bindHost,
    },
    attach: {
      host: attachHost,
    },
    backend: {
      mode: backendMode,
    },
  };
}

export function buildWorkspaceUrls(config, hostPort) {
  const bindHost = config.workspace.bindHost;
  const internalHost = bindHost === "0.0.0.0" ? DEFAULT_BIND_HOST : bindHost;
  return {
    serverUrl: `http://${internalHost}:${hostPort}`,
    attachServerUrl: `http://${config.attach.host}:${hostPort}`,
  };
}

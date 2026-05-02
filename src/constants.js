import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(SRC_DIR, "..");
export const CHALLENGES_DIR = path.join(ROOT_DIR, "challenges");
export const STATE_DIR = path.join(ROOT_DIR, ".flagdock");
export const STATE_PATH = path.join(STATE_DIR, "state.json");
export const DAEMON_PATH = path.join(STATE_DIR, "daemon.json");
export const LOG_PATH = path.join(STATE_DIR, "manager.log");
export const PROMPTS_DIR = path.join(ROOT_DIR, "prompts");
export const AGENT_DIR = path.join(PROMPTS_DIR, "agents");
export const AGENT_FILE = path.join(AGENT_DIR, "ctf.md");
export const SESSION_PROMPTS_DIR = path.join(PROMPTS_DIR, "sessions");
export const LOCAL_DIR = path.join(ROOT_DIR, ".local");
export const LOCAL_OPENCODE_DIR = path.join(LOCAL_DIR, "opencode");
export const OPENCODE_CONFIG_FILE = path.join(LOCAL_OPENCODE_DIR, "opencode.json");
export const LEGACY_OPENCODE_CONFIG_FILE = path.join(ROOT_DIR, "opencode.json");
export const OPENCODE_AUTH_FILE = path.join(LOCAL_OPENCODE_DIR, "auth.json");
export const FLAGDOCK_CONFIG_FILE = path.join(ROOT_DIR, "flagdock.yaml");
export const CONTAINER_CHALLENGE_DIR = "/challenge";
export const AGENT_NAME = "ctf";
export const BASE_IMAGE = "flagdock-sandbox-base:latest";
export const WORK_IMAGE = "flagdock-opencode:latest";
export const OPENCODE_PORT = 4096;
export const DEFAULT_MANAGER_HOST = "127.0.0.1";
export const DEFAULT_AUTO_INTERVAL_MS = Number.parseInt(process.env.FLAGDOCK_AUTO_INTERVAL_MS ?? "120000", 10);

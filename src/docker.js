import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  BACKENDS,
  BASE_IMAGE,
  CODEX_CONFIG_FILE,
  RUNTIME_AGENT_DIR,
  RUNTIME_CODEX_AGENTS_FILE,
  CODEX_IMAGE,
  CODEX_PORT,
  CONTAINER_CHALLENGE_DIR,
  LEGACY_OPENCODE_CONFIG_FILE,
  OPENCODE_AUTH_FILE,
  OPENCODE_CONFIG_FILE,
  OPENCODE_PORT,
  RUNTIME_OPENCODE_MANAGED_CONFIG_DIR,
  ROOT_DIR,
  SOLUTION_FLAG_FILE,
  SOLUTION_WRITEUP_FILE,
  WORKSPACES_DIR,
  WORK_IMAGE,
  CODEX_ENV_FILE,
} from "./constants.js";
import { ensureDir, pathExists, slugify } from "./util.js";

const execFileAsync = promisify(execFile);
const CONTAINER_OPENCODE_AGENT_DIR = "/root/.opencode/agent";
const CONTAINER_OPENCODE_CONFIG_FILE = "/root/.config/opencode/opencode.json";
const CONTAINER_OPENCODE_AUTH_FILE = "/root/.local/share/opencode/auth.json";
const CONTAINER_OPENCODE_MANAGED_CONFIG_DIR = "/etc/opencode";

export async function runDocker(args, options = {}) {
  try {
    const result = await execFileAsync("docker", args, {
      cwd: ROOT_DIR,
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
    return result.stdout.trim();
  } catch (error) {
    const stderr = error?.stderr?.trim();
    const stdout = error?.stdout?.trim();
    const detail = stderr || stdout || error.message;
    const wrapped = new Error(`docker ${args.join(" ")} failed: ${detail}`);
    wrapped.code = error?.code;
    throw wrapped;
  }
}

export function workspaceContainerName(challenge) {
  return `flagdock-${slugify(challenge)}`;
}

export function backendContainerName(challenge, backend) {
  if (backend === "codex") {
    return `${workspaceContainerName(challenge)}-codex`;
  }
  return workspaceContainerName(challenge);
}

export function backendWorkspaceRoot(challenge, backend) {
  return path.join(WORKSPACES_DIR, slugify(challenge), backend);
}

export function challengeWorkspaceRoot(challenge) {
  return path.join(WORKSPACES_DIR, slugify(challenge));
}

export function backendChallengeDir(challenge, backend) {
  return path.join(backendWorkspaceRoot(challenge, backend), "challenge");
}

export async function removeBackendWorkspaceDir(challenge, backend) {
  await fs.rm(backendWorkspaceRoot(challenge, backend), { recursive: true, force: true });
}

export async function removeChallengeWorkspaceDirIfEmpty(challenge) {
  const workspaceRoot = challengeWorkspaceRoot(challenge);
  try {
    await fs.rmdir(workspaceRoot);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTEMPTY") {
      return;
    }
    throw error;
  }
}

export async function dockerAvailable() {
  try {
    await runDocker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

export async function imageExists(image) {
  try {
    await runDocker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureImages(backends, log = () => {}) {
  const selected = new Set(Array.isArray(backends) ? backends : [backends]);
  if (!await imageExists(BASE_IMAGE)) {
    log(`building ${BASE_IMAGE} from sandbox/Dockerfile.sandbox`);
    await runDocker(["build", "-f", "sandbox/Dockerfile.sandbox", "-t", BASE_IMAGE, "."]);
  }
  if (selected.has("opencode") && !await imageExists(WORK_IMAGE)) {
    log(`building ${WORK_IMAGE} from Dockerfile.opencode`);
    await runDocker(["build", "-f", "Dockerfile.opencode", "--build-arg", `BASE_IMAGE=${BASE_IMAGE}`, "-t", WORK_IMAGE, "."]);
  }
  if (selected.has("codex") && !await imageExists(CODEX_IMAGE)) {
    log(`building ${CODEX_IMAGE} from Dockerfile.codex`);
    await runDocker(["build", "-f", "Dockerfile.codex", "--build-arg", `BASE_IMAGE=${BASE_IMAGE}`, "-t", CODEX_IMAGE, "."]);
  }
}

export async function inspectContainer(name) {
  try {
    const raw = await runDocker(["inspect", name]);
    return JSON.parse(raw)[0] ?? null;
  } catch {
    return null;
  }
}

export function containerRunning(inspect) {
  return inspect?.State?.Running === true;
}

export function containerStatus(inspect) {
  if (!inspect) {
    return null;
  }
  return containerRunning(inspect) ? "running" : "stopped";
}

export function containerHostPort(inspect, containerPort = OPENCODE_PORT) {
  const bindings = inspect?.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
  const first = Array.isArray(bindings) ? bindings[0] : null;
  return first?.HostPort ? Number.parseInt(first.HostPort, 10) : null;
}

function containerMountSource(inspect, destination) {
  const mount = inspect?.Mounts?.find((item) => item.Destination === destination);
  return mount?.Source ? path.resolve(mount.Source) : null;
}

async function firstExistingPath(paths) {
  for (const filePath of paths) {
    if (await pathExists(filePath)) {
      return filePath;
    }
  }
  return null;
}

function shouldCopyChallengeEntry(challengeDir, source) {
  const relative = path.relative(challengeDir, source);
  if (!relative) {
    return true;
  }
  if (relative === SOLUTION_FLAG_FILE || relative === SOLUTION_WRITEUP_FILE) {
    return false;
  }
  const [topLevel] = relative.split(path.sep);
  if (BACKENDS.some((backend) => topLevel === `${backend}_solution`)) {
    return false;
  }
  return true;
}

async function ensureBackendChallengeCopy(challenge, challengeDir, backend) {
  const target = backendChallengeDir(challenge, backend);
  if (await pathExists(target)) {
    return target;
  }
  await fs.rm(target, { recursive: true, force: true });
  await ensureDir(path.dirname(target));
  await fs.cp(challengeDir, target, {
    recursive: true,
    filter: (source) => shouldCopyChallengeEntry(challengeDir, source),
  });
  return target;
}

async function ensureCodexChallengeAgentsFile(challengeDir) {
  await fs.copyFile(RUNTIME_CODEX_AGENTS_FILE, path.join(challengeDir, "AGENTS.md"));
}

async function ensureExpectedMounts(inspected, name, expectedMounts, log = () => {}) {
  if (!inspected) {
    return null;
  }
  for (const mount of expectedMounts) {
    const mountedSource = containerMountSource(inspected, mount.destination);
    if (mountedSource === path.resolve(mount.source)) {
      continue;
    }
    log(`recreating container ${name} to refresh ${mount.destination} mount`);
    await runDocker(["rm", "-f", name]);
    return null;
  }
  return inspected;
}

async function ensureMountsAbsent(inspected, name, destinations, log = () => {}) {
  if (!inspected) {
    return null;
  }
  for (const destination of destinations) {
    if (!containerMountSource(inspected, destination)) {
      continue;
    }
    log(`recreating container ${name} to remove ${destination} mount`);
    await runDocker(["rm", "-f", name]);
    return null;
  }
  return inspected;
}

export function buildOpenCodeDockerArgs({
  bindHost,
  containerName,
  runtimeChallengeDir,
  agentDir,
  managedConfigDir,
  opencodeConfigFile = null,
  opencodeAuthFile = null,
  includeOpenCodeConfigContent = false,
}) {
  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "--privileged",
    "--cap-add=SYS_PTRACE",
    "--security-opt",
    "seccomp=unconfined",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `${bindHost}::${OPENCODE_PORT}`,
    "-v",
    `${path.resolve(runtimeChallengeDir)}:${CONTAINER_CHALLENGE_DIR}`,
    "-v",
    `${path.resolve(agentDir)}:${CONTAINER_OPENCODE_AGENT_DIR}:ro`,
    "-v",
    `${path.resolve(managedConfigDir)}:${CONTAINER_OPENCODE_MANAGED_CONFIG_DIR}:ro`,
  ];
  if (opencodeConfigFile) {
    args.push("-v", `${path.resolve(opencodeConfigFile)}:${CONTAINER_OPENCODE_CONFIG_FILE}:ro`);
  }
  if (opencodeAuthFile) {
    args.push("-v", `${path.resolve(opencodeAuthFile)}:${CONTAINER_OPENCODE_AUTH_FILE}:ro`);
  }
  if (includeOpenCodeConfigContent) {
    args.push("-e", "OPENCODE_CONFIG_CONTENT");
  }
  args.push(WORK_IMAGE);
  return args;
}

export async function startWorkspaceContainer({ bindHost, challenge, challengeDir, log = () => {} }) {
  const name = backendContainerName(challenge, "opencode");
  const runtimeChallengeDir = await ensureBackendChallengeCopy(challenge, challengeDir, "opencode");
  let inspected = await inspectContainer(name);
  inspected = await ensureExpectedMounts(inspected, name, [
    { destination: CONTAINER_CHALLENGE_DIR, source: runtimeChallengeDir },
    { destination: CONTAINER_OPENCODE_AGENT_DIR, source: RUNTIME_AGENT_DIR },
    { destination: CONTAINER_OPENCODE_MANAGED_CONFIG_DIR, source: RUNTIME_OPENCODE_MANAGED_CONFIG_DIR },
  ], log);
  if (inspected && !containerRunning(inspected)) {
    log(`starting existing container ${name}`);
    await runDocker(["start", name]);
    inspected = await inspectContainer(name);
  }
  if (!inspected) {
    const opencodeConfigFile = await firstExistingPath([
      OPENCODE_CONFIG_FILE,
      LEGACY_OPENCODE_CONFIG_FILE,
    ]);
    const args = buildOpenCodeDockerArgs({
      bindHost,
      containerName: name,
      runtimeChallengeDir,
      agentDir: RUNTIME_AGENT_DIR,
      managedConfigDir: RUNTIME_OPENCODE_MANAGED_CONFIG_DIR,
      opencodeConfigFile,
      opencodeAuthFile: await pathExists(OPENCODE_AUTH_FILE) ? OPENCODE_AUTH_FILE : null,
      includeOpenCodeConfigContent: Boolean(process.env.OPENCODE_CONFIG_CONTENT),
    });
    log(`creating container ${name}`);
    await runDocker(args);
    inspected = await inspectContainer(name);
  }
  const port = containerHostPort(inspected, OPENCODE_PORT);
  if (!port) {
    throw new Error(`Container ${name} has no published ${OPENCODE_PORT}/tcp port`);
  }
  return {
    backend: "opencode",
    challengeDir: runtimeChallengeDir,
    containerName: name,
    hostPort: port,
    status: "running",
  };
}

export async function startCodexWorkspaceContainer({ bindHost, challenge, challengeDir, log = () => {} }) {
  const name = backendContainerName(challenge, "codex");
  const runtimeChallengeDir = await ensureBackendChallengeCopy(challenge, challengeDir, "codex");
  await ensureCodexChallengeAgentsFile(runtimeChallengeDir);
  let inspected = await inspectContainer(name);
  inspected = await ensureExpectedMounts(inspected, name, [
    { destination: CONTAINER_CHALLENGE_DIR, source: runtimeChallengeDir },
  ], log);
  inspected = await ensureMountsAbsent(inspected, name, [
    `${CONTAINER_CHALLENGE_DIR}/AGENTS.md`,
  ], log);
  if (inspected && !containerRunning(inspected)) {
    log(`starting existing container ${name}`);
    await runDocker(["start", name]);
    inspected = await inspectContainer(name);
  }
  if (!inspected) {
    if (!await pathExists(CODEX_CONFIG_FILE)) {
      throw new Error(`Missing Codex config file: ${CODEX_CONFIG_FILE}`);
    }
    if (!await pathExists(CODEX_ENV_FILE)) {
      throw new Error(`Missing Codex env file: ${CODEX_ENV_FILE}`);
    }
    const codexHomeDir = path.join(backendWorkspaceRoot(challenge, "codex"), "codex-home");
    await ensureDir(codexHomeDir);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--privileged",
      "--cap-add=SYS_PTRACE",
      "--security-opt",
      "seccomp=unconfined",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `${bindHost}::${CODEX_PORT}`,
      "--env-file",
      path.resolve(CODEX_ENV_FILE),
      "-v",
      `${path.resolve(runtimeChallengeDir)}:${CONTAINER_CHALLENGE_DIR}`,
      "-v",
      `${path.resolve(codexHomeDir)}:/root/.codex`,
      "-v",
      `${path.resolve(CODEX_CONFIG_FILE)}:/root/.codex/config.toml:ro`,
      CODEX_IMAGE,
    ];
    log(`creating container ${name}`);
    await runDocker(args);
    inspected = await inspectContainer(name);
  }
  const port = containerHostPort(inspected, CODEX_PORT);
  if (!port) {
    throw new Error(`Container ${name} has no published ${CODEX_PORT}/tcp port`);
  }
  return {
    backend: "codex",
    challengeDir: runtimeChallengeDir,
    containerName: name,
    hostPort: port,
    status: "running",
  };
}

export async function stopWorkspaceContainer(challenge, backend = "opencode") {
  const name = backendContainerName(challenge, backend);
  const inspected = await inspectContainer(name);
  if (!inspected || !containerRunning(inspected)) {
    return false;
  }
  await runDocker(["stop", name]);
  return true;
}

export async function removeWorkspaceContainer(challenge, backend = "opencode") {
  const name = backendContainerName(challenge, backend);
  const inspected = await inspectContainer(name);
  if (!inspected) {
    return false;
  }
  await runDocker(["rm", "-f", name]);
  return true;
}

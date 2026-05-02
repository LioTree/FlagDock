import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_DIR,
  BASE_IMAGE,
  LEGACY_OPENCODE_CONFIG_FILE,
  OPENCODE_AUTH_FILE,
  OPENCODE_CONFIG_FILE,
  OPENCODE_PORT,
  ROOT_DIR,
  WORK_IMAGE,
} from "./constants.js";
import { pathExists, slugify } from "./util.js";

const execFileAsync = promisify(execFile);

async function runDocker(args, options = {}) {
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

export async function ensureImages(log = () => {}) {
  if (!await imageExists(BASE_IMAGE)) {
    log(`building ${BASE_IMAGE} from sandbox/Dockerfile.sandbox`);
    await runDocker(["build", "-f", "sandbox/Dockerfile.sandbox", "-t", BASE_IMAGE, "."]);
  }
  if (!await imageExists(WORK_IMAGE)) {
    log(`building ${WORK_IMAGE} from Dockerfile`);
    await runDocker(["build", "-f", "Dockerfile", "--build-arg", `BASE_IMAGE=${BASE_IMAGE}`, "-t", WORK_IMAGE, "."]);
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

export function containerHostPort(inspect) {
  const bindings = inspect?.NetworkSettings?.Ports?.[`${OPENCODE_PORT}/tcp`];
  const first = Array.isArray(bindings) ? bindings[0] : null;
  return first?.HostPort ? Number.parseInt(first.HostPort, 10) : null;
}

async function firstExistingPath(paths) {
  for (const filePath of paths) {
    if (await pathExists(filePath)) {
      return filePath;
    }
  }
  return null;
}

export async function startWorkspaceContainer({ bindHost, challenge, challengeDir, log = () => {} }) {
  const name = workspaceContainerName(challenge);
  let inspected = await inspectContainer(name);
  if (inspected && !containerRunning(inspected)) {
    log(`starting existing container ${name}`);
    await runDocker(["start", name]);
    inspected = await inspectContainer(name);
  }
  if (!inspected) {
    const agentDir = path.resolve(AGENT_DIR);
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
      `${bindHost}::${OPENCODE_PORT}`,
      "-v",
      `${path.resolve(challengeDir)}:/challenge`,
      "-v",
      `${agentDir}:/root/.opencode/agent:ro`,
    ];
    const opencodeConfigFile = await firstExistingPath([
      OPENCODE_CONFIG_FILE,
      LEGACY_OPENCODE_CONFIG_FILE,
    ]);
    if (opencodeConfigFile) {
      args.push("-v", `${path.resolve(opencodeConfigFile)}:/root/.config/opencode/opencode.json:ro`);
    }
    if (await pathExists(OPENCODE_AUTH_FILE)) {
      args.push("-v", `${path.resolve(OPENCODE_AUTH_FILE)}:/root/.local/share/opencode/auth.json:ro`);
    }
    if (process.env.OPENCODE_CONFIG_CONTENT) {
      args.push("-e", "OPENCODE_CONFIG_CONTENT");
    }
    args.push(WORK_IMAGE);
    log(`creating container ${name}`);
    await runDocker(args);
    inspected = await inspectContainer(name);
  }
  const port = containerHostPort(inspected);
  if (!port) {
    throw new Error(`Container ${name} has no published ${OPENCODE_PORT}/tcp port`);
  }
  return {
    containerName: name,
    hostPort: port,
    status: "running",
  };
}

export async function stopWorkspaceContainer(challenge) {
  const name = workspaceContainerName(challenge);
  const inspected = await inspectContainer(name);
  if (!inspected) {
    return false;
  }
  if (containerRunning(inspected)) {
    await runDocker(["stop", name]);
  }
  return true;
}

export async function removeWorkspaceContainer(challenge) {
  const name = workspaceContainerName(challenge);
  const inspected = await inspectContainer(name);
  if (!inspected) {
    return false;
  }
  await runDocker(["rm", "-f", name]);
  return true;
}

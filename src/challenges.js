import fs from "node:fs/promises";
import path from "node:path";
import { BACKENDS, CHALLENGES_DIR, SOLUTION_FLAG_FILE, SOLUTION_WRITEUP_FILE } from "./constants.js";
import { nonEmptyFile, pathExists } from "./util.js";

export async function resolveChallengePath(challenge, challengesDir = CHALLENGES_DIR) {
  if (!challenge || challenge.includes("/") || challenge.includes("\\") || challenge === "." || challenge === "..") {
    throw new Error(`Invalid challenge name: ${challenge}`);
  }
  const rootDir = path.resolve(challengesDir);
  const challengeDir = path.resolve(rootDir, challenge);
  const root = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (challengeDir !== rootDir && !challengeDir.startsWith(root)) {
    throw new Error(`Invalid challenge path: ${challenge}`);
  }
  return challengeDir;
}

export async function getChallengeInfoAtPath(challenge, dir) {
  const challengeMd = path.join(dir, "challenge.md");
  const exists = await pathExists(dir);
  const valid = exists && await pathExists(challengeMd);
  const solutions = {};
  const solvedBackends = [];
  for (const backend of BACKENDS) {
    const solutionDir = path.join(dir, `${backend}_solution`);
    const flagPath = path.join(solutionDir, SOLUTION_FLAG_FILE);
    const writeupPath = path.join(solutionDir, SOLUTION_WRITEUP_FILE);
    const solved = valid && await nonEmptyFile(flagPath);
    const hasWriteup = valid && await nonEmptyFile(writeupPath);
    if (solved) {
      solvedBackends.push(backend);
    }
    solutions[backend] = {
      dir: solutionDir,
      flagPath,
      writeupPath,
      solved,
      hasWriteup,
    };
  }
  const solved = solvedBackends.length > 0;
  return {
    name: challenge,
    dir,
    valid,
    solved,
    solvedBackends,
    solutions,
    baseStatus: valid ? (solved ? "solved" : "available") : "invalid",
  };
}

export async function getChallengeInfo(challenge, challengesDir = CHALLENGES_DIR) {
  const dir = await resolveChallengePath(challenge, challengesDir);
  return getChallengeInfoAtPath(challenge, dir);
}

export async function scanChallenges(challengesDir = CHALLENGES_DIR, workspaces = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(challengesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const info = await getChallengeInfo(entry.name, challengesDir);
    const workspace = workspaces[entry.name];
    let status = info.baseStatus;
    const backendStates = Object.values(workspace?.backends ?? {});
    const hasRunning = backendStates.some((backend) => backend.status === "running");
    const hasStopped = backendStates.some((backend) => backend.status === "stopped");
    if (!info.solved && info.valid && hasRunning) {
      status = "running";
    } else if (!info.solved && info.valid && hasStopped) {
      status = "stopped";
    }
    result.push({
      challenge: info.name,
      status,
      path: info.dir,
      sessions: backendStates.reduce((sum, backend) => sum + Object.keys(backend.sessions ?? {}).length, 0),
      primary_session: workspace?.backends?.opencode?.primarySessionId ?? "",
      solved_by: workspace?.solvedBy ?? info.solvedBackends[0] ?? "",
      backends: BACKENDS.filter((backend) => workspace?.backends?.[backend]).join(","),
    });
  }
  return result.sort((a, b) => a.challenge.localeCompare(b.challenge));
}

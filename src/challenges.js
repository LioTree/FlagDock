import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { BACKENDS, CHALLENGES_DIR, SOLUTION_FLAG_FILE, SOLUTION_WRITEUP_FILE, SOLUTIONS_DIR } from "./constants.js";
import { ensureDir, nonEmptyFile, pathExists } from "./util.js";

function validateChallengeName(challenge) {
  if (!challenge || challenge.includes("/") || challenge.includes("\\") || challenge === "." || challenge === "..") {
    throw new Error(`Invalid challenge name: ${challenge}`);
  }
  return challenge;
}

export function challengeSolutionStateRoot(challenge, challengeDir) {
  const name = validateChallengeName(challenge);
  const scopedPath = path.resolve(challengeDir);
  const scope = crypto.createHash("sha256").update(scopedPath).digest("hex").slice(0, 16);
  return path.join(SOLUTIONS_DIR, `${name}-${scope}`);
}

function legacyChallengeSolutionStateRoot(challenge) {
  return path.join(SOLUTIONS_DIR, validateChallengeName(challenge));
}

export function backendSolutionStateDir(challenge, challengeDir, backend) {
  return path.join(challengeSolutionStateRoot(challenge, challengeDir), backend);
}

function backendSolutionPaths(challenge, challengeDir, backend) {
  const stateDir = backendSolutionStateDir(challenge, challengeDir, backend);
  return {
    stateDir,
    flagPath: path.join(stateDir, SOLUTION_FLAG_FILE),
    writeupPath: path.join(stateDir, SOLUTION_WRITEUP_FILE),
  };
}

async function removeDirIfEmpty(dir) {
  try {
    await fs.rmdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTEMPTY") {
      return;
    }
    throw error;
  }
}

async function copyLegacySolutionFileIfMissing(sourcePath, targetPath) {
  if (!await nonEmptyFile(sourcePath) || await nonEmptyFile(targetPath)) {
    return;
  }
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
  await fs.rm(sourcePath, { force: true });
}

async function migrateLegacySolutionState(challenge, solution, backend) {
  const legacyRoot = legacyChallengeSolutionStateRoot(challenge);
  const legacyDir = path.join(legacyRoot, backend);
  if (!await pathExists(legacyDir)) {
    return;
  }
  if (!await pathExists(solution.stateDir)) {
    await ensureDir(path.dirname(solution.stateDir));
    await fs.rename(legacyDir, solution.stateDir);
  } else {
    await copyLegacySolutionFileIfMissing(path.join(legacyDir, SOLUTION_FLAG_FILE), solution.flagPath);
    await copyLegacySolutionFileIfMissing(path.join(legacyDir, SOLUTION_WRITEUP_FILE), solution.writeupPath);
    await removeDirIfEmpty(legacyDir);
  }
  await removeDirIfEmpty(legacyRoot);
}

export async function removeChallengeSolutionStateDirIfEmpty(challenge, challengeDir) {
  const solutionRoot = challengeSolutionStateRoot(challenge, challengeDir);
  await removeDirIfEmpty(solutionRoot);
}

export async function resolveChallengePath(challenge, challengesDir = CHALLENGES_DIR) {
  const name = validateChallengeName(challenge);
  const rootDir = path.resolve(challengesDir);
  const challengeDir = path.resolve(rootDir, name);
  const root = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (challengeDir !== rootDir && !challengeDir.startsWith(root)) {
    throw new Error(`Invalid challenge path: ${name}`);
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
    const solution = backendSolutionPaths(challenge, dir, backend);
    if (exists) {
      await migrateLegacySolutionState(challenge, solution, backend);
    }
    const solved = valid && await nonEmptyFile(solution.flagPath);
    const hasWriteup = valid && await nonEmptyFile(solution.writeupPath);
    if (solved) {
      solvedBackends.push(backend);
    }
    solutions[backend] = {
      ...solution,
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

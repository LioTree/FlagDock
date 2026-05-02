import fs from "node:fs/promises";
import path from "node:path";
import { CHALLENGES_DIR } from "./constants.js";
import { nonEmptyFile, pathExists } from "./util.js";

export async function resolveChallengePath(challenge) {
  if (!challenge || challenge.includes("/") || challenge.includes("\\") || challenge === "." || challenge === "..") {
    throw new Error(`Invalid challenge name: ${challenge}`);
  }
  const challengeDir = path.resolve(CHALLENGES_DIR, challenge);
  const root = `${path.resolve(CHALLENGES_DIR)}${path.sep}`;
  if (!challengeDir.startsWith(root)) {
    throw new Error(`Invalid challenge path: ${challenge}`);
  }
  return challengeDir;
}

export async function getChallengeInfo(challenge) {
  const dir = await resolveChallengePath(challenge);
  const challengeMd = path.join(dir, "challenge.md");
  const flagPath = path.join(dir, "flag.txt");
  const exists = await pathExists(dir);
  const valid = exists && await pathExists(challengeMd);
  const solved = valid && await nonEmptyFile(flagPath);
  return {
    name: challenge,
    dir,
    flagPath,
    valid,
    solved,
    baseStatus: valid ? (solved ? "solved" : "available") : "invalid",
  };
}

export async function scanChallenges(workspaces = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(CHALLENGES_DIR, { withFileTypes: true });
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
    const info = await getChallengeInfo(entry.name);
    const workspace = workspaces[entry.name];
    let status = info.baseStatus;
    if (!info.solved && info.valid && workspace?.status === "running") {
      status = "running";
    } else if (!info.solved && info.valid && workspace?.status === "stopped") {
      status = "stopped";
    }
    result.push({
      challenge: info.name,
      status,
      path: info.dir,
      sessions: Object.keys(workspace?.sessions ?? {}).length,
      primary_session: workspace?.primarySessionId ?? "",
      server_url: workspace?.serverUrl ?? "",
    });
  }
  return result.sort((a, b) => a.challenge.localeCompare(b.challenge));
}

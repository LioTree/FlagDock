import path from "node:path";
import { AGENT_FILE, SESSION_PROMPTS_DIR } from "./constants.js";
import { readText } from "./util.js";

export async function ensureAgentFile() {
  await readText(AGENT_FILE).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing OpenCode agent file: ${AGENT_FILE}`);
    }
    throw error;
  });
  return AGENT_FILE;
}

export async function readSessionPrompt(kind) {
  const file = path.join(SESSION_PROMPTS_DIR, `${kind}.md`);
  const prompt = await readText(file).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing session prompt file: ${file}`);
    }
    throw error;
  });
  return prompt.trim();
}

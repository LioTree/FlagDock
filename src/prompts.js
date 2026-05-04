import path from "node:path";
import {
  COMMON_CTF_PROMPT_FILE,
  RUNTIME_CODEX_AGENTS_FILE,
  RUNTIME_OPENCODE_AGENT_FILE,
  SESSION_PROMPTS_DIR,
} from "./constants.js";
import { readText, writeText } from "./util.js";

const OPENCODE_AGENT_FRONTMATTER = `---
description: Primary and sub agents for CTF.
mode: all
permission:
  bash:
    "*": allow
  glob:
    "*": allow
  grep:
    "*": allow
  read:
    "*": allow
  list:
    "*": allow
  edit:
    "*": allow
  external_directory:
    "*": allow
  task:
    "*": allow
  skill:
    "*": allow
  lsp:
    "*": allow
  webfetch: allow
  websearch: allow
  codesearch: allow
  todowrite: allow
  question: allow
---`;

async function readPromptFile(file, label) {
  const prompt = await readText(file).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${file}`);
    }
    throw error;
  });
  return prompt.trim();
}

function joinSections(...sections) {
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

function renderOpenCodeAgentPrompt(body) {
  return joinSections(OPENCODE_AGENT_FRONTMATTER, body);
}

function renderCodexAgentsPrompt(body) {
  return joinSections(body);
}

export async function ensureAgentRuntimeFiles() {
  const body = await readPromptFile(COMMON_CTF_PROMPT_FILE, "common CTF prompt file");
  await Promise.all([
    writeText(RUNTIME_OPENCODE_AGENT_FILE, renderOpenCodeAgentPrompt(body)),
    writeText(RUNTIME_CODEX_AGENTS_FILE, renderCodexAgentsPrompt(body)),
  ]);
  return {
    opencodeAgentFile: RUNTIME_OPENCODE_AGENT_FILE,
    codexAgentsFile: RUNTIME_CODEX_AGENTS_FILE,
  };
}

export async function readSessionPrompt(kind) {
  const file = path.join(SESSION_PROMPTS_DIR, `${kind}.md`);
  return readPromptFile(file, "session prompt file");
}

import path from "node:path";
import {
  COMMON_CTF_PROMPT_FILE,
  RUNTIME_CODEX_AGENTS_FILE,
  RUNTIME_OPENCODE_MANAGED_CONFIG_FILE,
  RUNTIME_OPENCODE_AGENT_FILE,
  SESSION_PROMPTS_DIR,
} from "./constants.js";
import { readText, writeJson, writeText } from "./util.js";

const OPENCODE_AGENT_FRONTMATTER = `---
description: Primary CTF agent.
mode: primary
permission:
  "*": deny
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
    "*": deny
    general: allow
    explore: allow
  skill:
    "*": allow
  lsp:
    "*": allow
  webfetch: allow
  websearch: allow
  codesearch: allow
  todowrite: allow
  question: deny
---`;

const OPENCODE_SOLVER_PERMISSION = {
  "*": "deny",
  bash: { "*": "allow" },
  glob: { "*": "allow" },
  grep: { "*": "allow" },
  read: { "*": "allow" },
  list: { "*": "allow" },
  edit: { "*": "allow" },
  external_directory: { "*": "allow" },
  task: {
    "*": "deny",
    general: "allow",
    explore: "allow",
  },
  skill: { "*": "allow" },
  lsp: { "*": "allow" },
  webfetch: "allow",
  websearch: "allow",
  codesearch: "allow",
  todowrite: "allow",
  question: "deny",
};

const OPENCODE_GENERAL_PERMISSION = {
  "*": "deny",
  bash: { "*": "allow" },
  glob: { "*": "allow" },
  grep: { "*": "allow" },
  read: { "*": "allow" },
  list: { "*": "allow" },
  edit: { "*": "allow" },
  external_directory: { "*": "allow" },
  webfetch: "allow",
  websearch: "allow",
  codesearch: "allow",
  lsp: { "*": "allow" },
  question: "deny",
  task: "deny",
  todowrite: "deny",
};

const OPENCODE_EXPLORE_PERMISSION = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  bash: "allow",
  webfetch: "allow",
  websearch: "allow",
  codesearch: "allow",
  lsp: "allow",
  question: "deny",
  edit: "deny",
  task: "deny",
};

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

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

export function buildOpenCodeManagedConfig() {
  return {
    permission: {
      question: "deny",
    },
    agent: {
      build: {
        permission: cloneConfig(OPENCODE_SOLVER_PERMISSION),
      },
      general: {
        permission: cloneConfig(OPENCODE_GENERAL_PERMISSION),
      },
      explore: {
        permission: cloneConfig(OPENCODE_EXPLORE_PERMISSION),
      },
    },
  };
}

export function renderOpenCodeAgentPrompt(body) {
  return joinSections(OPENCODE_AGENT_FRONTMATTER, body);
}

function renderCodexAgentsPrompt(body) {
  return joinSections(body);
}

export async function ensureAgentRuntimeFiles() {
  const body = await readPromptFile(COMMON_CTF_PROMPT_FILE, "common CTF prompt file");
  await Promise.all([
    writeText(RUNTIME_OPENCODE_AGENT_FILE, renderOpenCodeAgentPrompt(body)),
    writeJson(RUNTIME_OPENCODE_MANAGED_CONFIG_FILE, buildOpenCodeManagedConfig()),
    writeText(RUNTIME_CODEX_AGENTS_FILE, renderCodexAgentsPrompt(body)),
  ]);
  return {
    opencodeAgentFile: RUNTIME_OPENCODE_AGENT_FILE,
    opencodeManagedConfigFile: RUNTIME_OPENCODE_MANAGED_CONFIG_FILE,
    codexAgentsFile: RUNTIME_CODEX_AGENTS_FILE,
  };
}

export async function readSessionPrompt(kind) {
  const file = path.join(SESSION_PROMPTS_DIR, `${kind}.md`);
  return readPromptFile(file, "session prompt file");
}

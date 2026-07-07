import assert from "node:assert/strict";
import test from "node:test";
import { FlagDockManager } from "../src/manager/index.js";
import { pollFlags } from "../src/cli/commands/flags.js";
import { beginAutoPromptTurn, finishAutoPromptTurn } from "../src/manager/backends/auto-prompt.js";
import { backendAdapter } from "../src/manager/backends/index.js";
import { ensurePrimarySession, managedSessionFields } from "../src/manager/backends/session-registry.js";

const REQUIRED_METHODS = [
  "urls",
  "startContainer",
  "waitUntilReady",
  "syncSessions",
  "ensurePrimarySession",
  "createSession",
  "resolveAttachTarget",
  "interruptSession",
  "sendAutoPromptTurn",
  "dispose",
];

test("backend adapters expose the manager contract", () => {
  for (const backend of ["opencode", "codex"]) {
    const adapter = backendAdapter(backend);
    assert.equal(adapter.name, backend);
    assert.equal(typeof adapter.port, "number");
    for (const method of REQUIRED_METHODS) {
      assert.equal(typeof adapter[method], "function", `${backend}.${method}`);
    }
  }
});

test("backend adapter rejects unknown backends", () => {
  assert.throws(() => backendAdapter("unknown"), /Invalid backend: unknown/);
});

test("backend adapters work with the shared manager context", async () => {
  const manager = new FlagDockManager();
  assert.equal("runtimes" in manager, false);
  assert.equal("codexClients" in manager, false);
  assert.equal("openCodeObservers" in manager, false);
  await backendAdapter("opencode").dispose(manager.context);
  await backendAdapter("codex").dispose(manager.context);
});

test("manager exposes named services instead of a flat api", () => {
  const manager = new FlagDockManager();
  assert.equal(Object.hasOwn(manager, "api"), false);
  assert.equal(typeof manager.services.workspaceRuntime.status, "function");
  assert.equal(typeof manager.services.sessions.attach, "function");
  assert.equal(typeof manager.services.auto.tick, "function");
  assert.equal(typeof manager.services.actions.startChallenge, "function");
  assert.equal("startChallenge" in manager, false);
  assert.equal("tick" in manager, false);
});

test("ensurePrimarySession creates once and preserves the primary id", async () => {
  const backendState = { sessions: {} };
  const workspace = { challenge: "sample" };
  const workspaceRuntime = {
    ensureBackendState() {
      return backendState;
    },
  };
  let createCalls = 0;

  const created = await ensurePrimarySession(workspaceRuntime, workspace, "opencode", "auto", async () => {
    createCalls += 1;
    const registry = { session_id: "session-1", mode: "auto" };
    backendState.sessions[registry.session_id] = registry;
    return registry;
  });
  const reused = await ensurePrimarySession(workspaceRuntime, workspace, "opencode", "manual", async () => {
    throw new Error("should not create a second primary session");
  });

  assert.equal(createCalls, 1);
  assert.equal(backendState.primarySessionId, "session-1");
  assert.equal(created, reused);
  assert.equal(reused.mode, "manual");
});

test("managedSessionFields preserves shared session metadata", () => {
  const existing = {
    created_at: "2026-01-01T00:00:00.000Z",
    last_auto_prompt_at: "2026-01-01T00:01:00.000Z",
    last_auto_prompt_kind: "initial",
    last_response_at: "2026-01-01T00:02:00.000Z",
    writeup_prompt_sent_at: "2026-01-01T00:03:00.000Z",
    last_error: "old error",
  };
  const fields = managedSessionFields("codex", { challenge: "sample" }, existing, {
    role: "primary",
    mode: "auto",
    createdAt: "ignored",
  });

  assert.equal(fields.backend, "codex");
  assert.equal(fields.challenge, "sample");
  assert.equal(fields.directory, "/challenge");
  assert.equal(fields.role, "primary");
  assert.equal(fields.mode, "auto");
  assert.equal(fields.created_at, existing.created_at);
  assert.equal(fields.last_auto_prompt_at, existing.last_auto_prompt_at);
  assert.equal(fields.last_error, existing.last_error);
});

test("auto prompt lifecycle updates registry status and completion fields", async () => {
  const workspace = { challenge: "sample" };
  const registry = { session_id: "session-1", status: "idle" };
  const saved = [];
  const logs = [];
  let solved = false;
  const context = {
    async save() {
      saved.push({ ...registry });
    },
    async log(message) {
      logs.push(message);
    },
  };
  const services = {
    workspaceRuntime: {
      async syncBackendOutputs() {},
      async workspaceChallengeInfo() {
        return { solved };
      },
      async reconcileSolvedBy() {},
    },
    sessions: {
      sessionRegistry() {
        return registry;
      },
      updateSessionRegistry(_workspace, _backend, _sessionID, values) {
        Object.assign(registry, values);
        return registry;
      },
    },
  };

  const { promptKind, prompt } = await beginAutoPromptTurn(context, services, workspace, "opencode", "session-1", "writeup");
  assert.equal(promptKind, "writeup");
  assert.match(prompt, /\S/);
  assert.equal(registry.status, "active");
  assert.equal(registry.last_auto_prompt_kind, "writeup");
  assert.equal(typeof registry.last_auto_prompt_at, "string");
  assert.equal(typeof registry.writeup_prompt_sent_at, "string");
  assert.equal(logs[0], "sending writeup prompt to opencode sample/session-1");

  solved = true;
  await finishAutoPromptTurn(context, services, workspace, "opencode", "session-1", { active_turn_id: "" });
  assert.equal(registry.status, "completed");
  assert.equal(registry.active_turn_id, "");
  assert.equal(registry.last_error, "");
  assert.equal(typeof registry.last_response_at, "string");
  assert.equal(saved.length, 2);
});

test("flag watch polling prints only newly seen flags", async () => {
  const seen = new Set();
  const printed = [];
  const fetchFlags = async () => ({
    flags: [
      { challenge: "sample", backend: "opencode", flag: "flag{one}" },
      { challenge: "sample", backend: "codex", flag: "flag{one}" },
    ],
  });

  assert.equal(await pollFlags(fetchFlags, seen, (item) => printed.push(item)), 2);
  assert.equal(await pollFlags(fetchFlags, seen, (item) => printed.push(item)), 0);
  assert.deepEqual(printed, [
    { challenge: "sample", backend: "opencode", flag: "flag{one}" },
    { challenge: "sample", backend: "codex", flag: "flag{one}" },
  ]);
});

test("workspace output sync isolates backend errors", async () => {
  const manager = new FlagDockManager();
  const logs = [];
  manager.context.log = async (message) => logs.push(message);
  manager.state = {
    version: 2,
    workspaces: {
      sample: {
        challenge: "sample",
        backends: {
          unknown: {},
          opencode: {},
        },
      },
    },
  };

  const result = await manager.services.workspaceRuntime.syncWorkspaceOutputs();
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0], {
    challenge: "sample",
    backend: "unknown",
    error: "Invalid backend: unknown",
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /sync outputs sample\/unknown failed: Invalid backend: unknown/);
});

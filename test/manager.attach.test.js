import test from "node:test";
import assert from "node:assert/strict";
import { FlagDockManager } from "../src/manager.js";

test("listAttachTargets prepares codex sessions through attachCodex", async () => {
  const manager = new FlagDockManager();
  manager.state = {
    workspaces: {
      sample: {
        challenge: "sample",
        backends: {
          codex: {
            backend: "codex",
            status: "running",
            sessions: {
              "session-1": {
                session_id: "session-1",
                thread_id: "thread-1",
              },
            },
          },
        },
      },
    },
  };

  manager.refreshWorkspaceContainerState = async () => {};
  manager.syncSessions = async () => {};

  let attachCodexCalls = 0;
  manager.attachCodex = async (workspace, session) => {
    attachCodexCalls += 1;
    assert.equal(workspace.challenge, "sample");
    assert.equal(session.session_id, "session-1");
    return {
      command: "docker exec -it codex tmux attach-session -t codex-session-1",
      url: "ws://codex.example",
    };
  };
  manager.attachTarget = () => {
    throw new Error("codex list mode should not bypass attachCodex");
  };

  const rows = await manager.listAttachTargets("sample", "codex");

  assert.equal(attachCodexCalls, 1);
  assert.deepEqual(rows, [
    {
      challenge: "sample",
      backend: "codex",
      session: "session-1",
      role: "",
      status: "",
      attach: "docker exec -it codex tmux attach-session -t codex-session-1",
      url: "ws://codex.example",
      command: "docker exec -it codex tmux attach-session -t codex-session-1",
    },
  ]);
});

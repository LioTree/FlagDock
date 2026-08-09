import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CODEX_IMAGE } from "../src/constants.js";
import {
  buildCodexDockerArgs,
  ensureCodexAppServerToken,
  readCodexAppServerToken,
} from "../src/docker.js";
import { codexTuiCommand } from "../src/manager/backends/codex/adapter.js";
import { CodexAppClient } from "../src/manager/backends/codex/client.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("Codex client authenticates the WebSocket upgrade with a bearer token", async (t) => {
  const token = "flagdock-test-token";
  let authorization = null;
  let threadStartParams = null;
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    authorization = request.headers.authorization ?? null;
    if (authorization !== `Bearer ${token}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });
  websocketServer.on("connection", (websocket) => {
    websocket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === "initialize") {
        websocket.send(JSON.stringify({ id: message.id, result: {} }));
      }
      if (message.method === "thread/start") {
        threadStartParams = message.params;
        websocket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: "thread-test",
              status: { type: "idle" },
            },
          },
        }));
      }
    });
  });

  const port = await listen(server);
  const client = new CodexAppClient(`ws://127.0.0.1:${port}`, token);
  t.after(async () => {
    client.dispose();
    for (const websocket of websocketServer.clients) {
      websocket.terminate();
    }
    websocketServer.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await client.connect();
  const thread = await client.startThread();

  assert.equal(authorization, `Bearer ${token}`);
  assert.equal(thread.id, "thread-test");
  assert.equal(threadStartParams.cwd, "/challenge");
  assert.equal(Object.hasOwn(threadStartParams, "persistExtendedHistory"), false);
});

test("Codex client requires authentication and uses current thread parameters", async () => {
  assert.throws(() => new CodexAppClient("ws://127.0.0.1:4097"), /authentication token is required/);

  const client = new CodexAppClient("ws://127.0.0.1:4097", "token");
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: "thread-test" } };
  };

  await client.startThread();
  await client.resumeThread("thread-test");

  assert.deepEqual(requests.map((request) => request.method), ["thread/start", "thread/resume"]);
  assert.equal(requests[1].params.threadId, "thread-test");
  assert.equal(requests[1].params.excludeTurns, true);
  for (const request of requests) {
    assert.equal(Object.hasOwn(request.params, "persistExtendedHistory"), false);
  }
});

test("Codex TUI reads the token inside the container without exposing it in argv", () => {
  const command = codexTuiCommand("thread; echo unsafe");

  assert.match(command, /cat '\/root\/\.codex\/app-server\.token'/);
  assert.match(command, /--remote-auth-token-env CODEX_REMOTE_AUTH_TOKEN/);
  assert.match(command, /resume 'thread; echo unsafe'/);
  assert.doesNotMatch(command, /flagdock-test-token/);
});

test("Codex container arguments use the versioned image and persistent Codex home", () => {
  const runtimeChallengeDir = "/tmp/flagdock-test/challenge";
  const codexHomeDir = "/tmp/flagdock-test/codex-home";
  const args = buildCodexDockerArgs({
    bindHost: "127.0.0.1",
    containerName: "flagdock-test-codex",
    runtimeChallengeDir,
    codexHomeDir,
  });

  assert.equal(args.at(-1), CODEX_IMAGE);
  assert.ok(args.includes(`${path.resolve(runtimeChallengeDir)}:/challenge`));
  assert.ok(args.includes(`${path.resolve(codexHomeDir)}:/root/.codex`));
  assert.ok(args.some((argument) => argument.endsWith(":/root/.codex/config.toml:ro")));
});

test("Codex app-server token is stable and private", async (t) => {
  const codexHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "flagdock-codex-token-"));
  t.after(() => fs.rm(codexHomeDir, { recursive: true, force: true }));

  const firstPath = await ensureCodexAppServerToken(codexHomeDir);
  const firstToken = await readCodexAppServerToken(firstPath);
  const secondPath = await ensureCodexAppServerToken(codexHomeDir);
  const secondToken = await readCodexAppServerToken(secondPath);
  const stat = await fs.stat(firstPath);

  assert.equal(firstPath, secondPath);
  assert.equal(firstToken, secondToken);
  assert.match(firstToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(stat.mode & 0o777, 0o600);
});

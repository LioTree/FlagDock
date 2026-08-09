import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OPENCODE_VERSION, ROOT_DIR, WORK_IMAGE } from "../src/constants.js";
import { buildOpenCodeDockerArgs, migrateOpenCodeData } from "../src/docker.js";
import { buildOpenCodeManagedConfig, renderOpenCodeAgentPrompt } from "../src/prompts.js";

test("OpenCode container uses the versioned image and persistent data directory", () => {
  const runtimeChallengeDir = "/tmp/flagdock-test/challenge";
  const agentDir = "/tmp/flagdock-test/agent";
  const managedConfigDir = "/tmp/flagdock-test/managed";
  const opencodeDataDir = "/tmp/flagdock-test/opencode-data";
  const args = buildOpenCodeDockerArgs({
    bindHost: "127.0.0.1",
    containerName: "flagdock-test",
    runtimeChallengeDir,
    agentDir,
    managedConfigDir,
    opencodeDataDir,
  });

  assert.equal(OPENCODE_VERSION, "1.18.15");
  assert.equal(WORK_IMAGE, `flagdock-opencode:${OPENCODE_VERSION}`);
  assert.equal(args.at(-1), WORK_IMAGE);
  assert.ok(args.includes(`${path.resolve(opencodeDataDir)}:/root/.local/share/opencode`));
});

test("OpenCode web mode keeps explicit headless permission policy", async () => {
  const dockerfile = await fs.readFile(path.join(ROOT_DIR, "Dockerfile.opencode"), "utf8");
  const managed = buildOpenCodeManagedConfig();
  const agent = renderOpenCodeAgentPrompt("test prompt");

  assert.match(dockerfile, /ARG OPENCODE_VERSION=1\.18\.15/);
  assert.match(dockerfile, /CMD \["opencode", "web", "--hostname", "0\.0\.0\.0", "--port", "4096"\]/);
  assert.doesNotMatch(dockerfile, /"--auto"/);
  assert.equal(managed.permission.question, "deny");
  assert.equal(managed.agent.build.permission["*"], "deny");
  assert.equal(managed.agent.build.permission.bash["*"], "allow");
  assert.equal(managed.agent.general.permission.task, "deny");
  assert.equal(managed.agent.explore.permission.edit, "deny");
  assert.match(agent, /permission:\n  "\*": deny/);
  assert.match(agent, /question: deny/);
});

test("OpenCode agent SDK resolves against the upgraded official packages", async () => {
  const lock = JSON.parse(await fs.readFile(path.join(ROOT_DIR, "package-lock.json"), "utf8"));

  assert.equal(lock.packages["node_modules/@liontree/opencode-agent-sdk"].version, "0.2.0");
  assert.equal(lock.packages["node_modules/@opencode-ai/sdk"].version, OPENCODE_VERSION);
  assert.equal(lock.packages["node_modules/opencode-ai"].version, OPENCODE_VERSION);
});

test("legacy OpenCode data is copied before a container is replaced", async (t) => {
  const opencodeDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flagdock-opencode-data-"));
  const copies = [];
  const logs = [];
  t.after(() => fs.rm(opencodeDataDir, { recursive: true, force: true }));

  const migrated = await migrateOpenCodeData(
    { Mounts: [] },
    "flagdock-legacy",
    opencodeDataDir,
    (message) => logs.push(message),
    async (source, destination) => {
      copies.push({ source, destination });
      await fs.writeFile(path.join(destination, "session-marker"), "preserved\n");
    },
  );

  assert.equal(migrated, true);
  assert.deepEqual(copies, [{
    source: "flagdock-legacy:/root/.local/share/opencode/.",
    destination: path.resolve(opencodeDataDir),
  }]);
  assert.match(logs[0], /migrating OpenCode data/);
  assert.equal(await fs.readFile(path.join(opencodeDataDir, "session-marker"), "utf8"), "preserved\n");

  const skipped = await migrateOpenCodeData(
    { Mounts: [] },
    "flagdock-legacy",
    opencodeDataDir,
    (message) => logs.push(message),
    () => assert.fail("non-empty persisted data must not be overwritten"),
  );
  assert.equal(skipped, false);
  assert.match(logs.at(-1), /keeping existing OpenCode data/);
});

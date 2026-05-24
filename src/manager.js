import http from "node:http";
import { DEFAULT_MANAGER_HOST, LOG_PATH } from "./constants.js";
import { getChallengeInfo, getChallengeInfoAtPath, scanChallenges } from "./challenges.js";
import { loadFlagDockConfig } from "./config.js";
import { ensureAgentRuntimeFiles } from "./prompts.js";
import { loadState, saveDaemonInfo, saveState } from "./state.js";
import { appendText, nowIso } from "./util.js";
import { autoMethods } from "./manager/auto.js";
import { httpMethods } from "./manager/http.js";
import { sessionMethods } from "./manager/sessions.js";
import { workspaceActionMethods } from "./manager/workspace-actions.js";
import { workspaceStateMethods } from "./manager/workspace-state.js";

export class FlagDockManager {
  constructor() {
    this.state = null;
    this.startedAt = nowIso();
    this.server = null;
    this.runtimes = new Map();
    this.codexClients = new Map();
    this.openCodeObservers = new Map();
    this.activeAutoLoops = new Map();
    this.tickTimer = null;
    this.stopping = false;
  }

  async log(message) {
    await appendText(LOG_PATH, `[${nowIso()}] ${message}\n`).catch(() => {});
  }

  async load() {
    this.state = await loadState();
  }

  async configuredChallengeInfo(challenge, config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    return getChallengeInfo(challenge, resolvedConfig.workspace.challengesDir);
  }

  async workspaceChallengeInfo(workspace, config = null) {
    if (workspace?.sourceDir) {
      return getChallengeInfoAtPath(workspace.challenge, workspace.sourceDir);
    }
    return this.configuredChallengeInfo(workspace.challenge, config);
  }

  async challengeInfoForAction(challenge, config = null) {
    const workspace = this.state.workspaces[challenge];
    if (workspace) {
      return this.workspaceChallengeInfo(workspace, config);
    }
    return this.configuredChallengeInfo(challenge, config);
  }

  async configuredChallengeList(config = null) {
    const resolvedConfig = config ?? await loadFlagDockConfig();
    return scanChallenges(resolvedConfig.workspace.challengesDir, this.state.workspaces);
  }

  async save() {
    await saveState(this.state);
  }

  async listen(port = 0) {
    await this.load();
    await ensureAgentRuntimeFiles();

    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, DEFAULT_MANAGER_HOST, resolve);
    });

    const address = this.server.address();
    await saveDaemonInfo({
      pid: process.pid,
      host: DEFAULT_MANAGER_HOST,
      port: address.port,
      started_at: this.startedAt,
    });
    await this.log(`manager listening on ${DEFAULT_MANAGER_HOST}:${address.port}`);
    this.startTicks();
  }

  startTicks() {
    this.tickTimer = setInterval(() => {
      this.tick().catch((error) => this.log(`tick failed: ${error.message}`));
    }, 30000);
    this.tick().catch((error) => this.log(`initial tick failed: ${error.message}`));
  }

  async close() {
    this.stopping = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    this.stopOpenCodeObservers();
    for (const runtime of this.runtimes.values()) {
      await runtime.dispose().catch(() => {});
    }
    for (const client of this.codexClients.values()) {
      client.dispose();
    }
    await this.save();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}

function installManagerMethods(methods) {
  Object.defineProperties(
    FlagDockManager.prototype,
    Object.fromEntries(
      Object.entries(methods).map(([name, value]) => [
        name,
        {
          value,
          writable: true,
          configurable: true,
        },
      ]),
    ),
  );
}

for (const methods of [workspaceStateMethods, sessionMethods, workspaceActionMethods, autoMethods, httpMethods]) {
  installManagerMethods(methods);
}

export async function runManager() {
  const manager = new FlagDockManager();
  process.on("SIGTERM", () => {
    manager.close().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    manager.close().then(() => process.exit(0));
  });
  await manager.listen(Number.parseInt(process.env.FLAGDOCK_MANAGER_PORT ?? "0", 10));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runManager().catch(async (error) => {
    await appendText(LOG_PATH, `[${nowIso()}] fatal: ${error.stack ?? error.message}\n`).catch(() => {});
    process.exit(1);
  });
}

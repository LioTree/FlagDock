import http from "node:http";
import { DEFAULT_MANAGER_HOST, LOG_PATH } from "../constants.js";
import { ensureAgentRuntimeFiles } from "../prompts.js";
import { loadState, saveDaemonInfo, saveState } from "../state.js";
import { appendText, nowIso } from "../util.js";
import { disposeBackendAdapters } from "./backends/index.js";
import { createHttpController } from "./http.js";
import { createAutoService } from "./services/auto.js";
import { createSessionService } from "./services/sessions.js";
import { createWorkspaceActionService } from "./services/workspace-actions.js";
import { createWorkspaceRuntimeService } from "./services/workspace-runtime.js";

function createManagerContext(manager) {
  return {
    get state() {
      return manager.state;
    },
    set state(value) {
      manager.state = value;
    },
    get startedAt() {
      return manager.startedAt;
    },
    get stopping() {
      return manager.stopping;
    },
    set stopping(value) {
      manager.stopping = value;
    },
    get activeAutoLoops() {
      return manager.activeAutoLoops;
    },
    async load() {
      manager.state = await loadState();
    },
    async save() {
      await saveState(manager.state);
    },
    async log(message) {
      await appendText(LOG_PATH, `[${nowIso()}] ${message}\n`).catch(() => {});
    },
  };
}

export class FlagDockManager {
  constructor() {
    this.state = null;
    this.startedAt = nowIso();
    this.server = null;
    this.activeAutoLoops = new Map();
    this.tickTimer = null;
    this.stopping = false;

    this.context = createManagerContext(this);
    const workspaceRuntime = createWorkspaceRuntimeService(this.context);
    const sessions = createSessionService(this.context, { workspaceRuntime });
    const auto = createAutoService(this.context, { workspaceRuntime, sessions });
    const actions = createWorkspaceActionService(this.context, { workspaceRuntime, sessions, auto });

    this.services = {
      workspaceRuntime,
      sessions,
      auto,
      actions,
    };

    this.http = createHttpController(this.services, () => this.close());
  }

  async log(message) {
    await this.context.log(message);
  }

  async load() {
    await this.context.load();
  }

  async save() {
    await this.context.save();
  }

  async listen(port = 0) {
    await this.load();
    await ensureAgentRuntimeFiles();

    this.server = http.createServer((request, response) => {
      this.http.handleRequest(request, response).catch((error) => {
        this.http.writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
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
      this.services.auto.tick().catch((error) => this.log(`tick failed: ${error.message}`));
    }, 30000);
    this.services.auto.tick().catch((error) => this.log(`initial tick failed: ${error.message}`));
  }

  async close() {
    this.stopping = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    await disposeBackendAdapters(this.context);
    await this.save();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
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

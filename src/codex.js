import { EventEmitter } from "node:events";
import { CODEX_PORT, CONTAINER_CHALLENGE_DIR } from "./constants.js";
import { sleep } from "./util.js";

const REQUEST_TIMEOUT_MS = 30000;
const TURN_TIMEOUT_MS = 30 * 60 * 1000;

function stringifyError(error) {
  if (!error) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return error.message;
  }
  return JSON.stringify(error);
}

function codexTextInput(text) {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function turnHasFinalAnswer(turn) {
  return Array.isArray(turn?.items) && turn.items.some((item) => item.type === "agentMessage" && item.phase === "final_answer");
}

export function codexHttpUrl(host, port) {
  return `http://${host}:${port}`;
}

export function codexWsUrl(host, port) {
  return `ws://${host}:${port}`;
}

export function codexContainerWsUrl() {
  return `ws://127.0.0.1:${CODEX_PORT}`;
}

export async function waitForCodex(serverUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Codex health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(750);
  }
  throw lastError ?? new Error("Timed out waiting for Codex app-server");
}

export class CodexAppClient extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextID = 1;
    this.pending = new Map();
    this.completedTurns = new Map();
    this.lastErrors = new Map();
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return this;
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to ${this.wsUrl}`));
      }, REQUEST_TIMEOUT_MS);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed connecting to ${this.wsUrl}`));
      }, { once: true });
      ws.addEventListener("message", (event) => this.handleMessage(event.data));
      ws.addEventListener("close", () => this.rejectPending(new Error("Codex app-server connection closed")));
      this.ws = ws;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "flagdock",
        title: "FlagDock",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
    return this;
  }

  dispose() {
    this.ws?.close();
    this.ws = null;
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleMessage(raw) {
    const text = typeof raw === "string" ? raw : raw.toString();
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(stringifyError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.handleNotificationOrRequest(message);
    }
  }

  handleNotificationOrRequest(message) {
    if (message.id != null) {
      this.respondToServerRequest(message);
      return;
    }
    if (message.method === "turn/completed") {
      const params = message.params ?? {};
      if (params.threadId && params.turn?.id) {
        this.completedTurns.set(`${params.threadId}:${params.turn.id}`, params.turn);
      }
    }
    if (message.method === "error") {
      const params = message.params ?? {};
      if (!params.willRetry && params.threadId && params.turnId) {
        this.lastErrors.set(`${params.threadId}:${params.turnId}`, params.error);
      }
    }
    this.emit("notification", message);
  }

  respondToServerRequest(message) {
    if (message.method.includes("requestApproval") || message.method === "execCommandApproval") {
      this.send({
        id: message.id,
        result: {
          decision: "deny",
        },
      });
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      this.send({
        id: message.id,
        result: {
          answers: {},
        },
      });
      return;
    }
    this.send({
      id: message.id,
      error: {
        message: `Unsupported server request: ${message.method}`,
      },
    });
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server connection is not open");
    }
    this.ws.send(JSON.stringify(message));
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = String(this.nextID);
    this.nextID += 1;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async startThread() {
    const response = await this.request("thread/start", {
      cwd: CONTAINER_CHALLENGE_DIR,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    return response.thread;
  }

  async resumeThread(threadID) {
    const response = await this.request("thread/resume", {
      threadId: threadID,
      cwd: CONTAINER_CHALLENGE_DIR,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      excludeTurns: true,
      persistExtendedHistory: true,
    });
    return response.thread;
  }

  async readThread(threadID) {
    const response = await this.request("thread/read", {
      threadId: threadID,
      includeTurns: true,
    });
    return response.thread;
  }

  async startTurn(threadID, prompt) {
    const response = await this.request("turn/start", {
      threadId: threadID,
      input: [codexTextInput(prompt)],
      cwd: CONTAINER_CHALLENGE_DIR,
      approvalPolicy: "never",
    });
    return response.turn;
  }

  async interruptTurn(threadID, turnID) {
    await this.request("turn/interrupt", {
      threadId: threadID,
      turnId: turnID,
    });
  }

  async runTurn(threadID, prompt) {
    const turn = await this.startTurn(threadID, prompt);
    return this.waitForTurn(threadID, turn.id);
  }

  async readTurn(threadID, turnID) {
    const thread = await this.readThread(threadID);
    return thread?.turns?.find((turn) => turn.id === turnID) ?? null;
  }

  waitForTurn(threadID, turnID, timeoutMs = TURN_TIMEOUT_MS) {
    const key = `${threadID}:${turnID}`;
    const completed = this.completedTurns.get(key);
    if (completed) {
      return Promise.resolve(completed);
    }
    const lastError = this.lastErrors.get(key);
    if (lastError) {
      return Promise.reject(new Error(stringifyError(lastError)));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer = null;
      const timer = setTimeout(() => {
        settled = true;
        if (pollTimer) {
          clearTimeout(pollTimer);
        }
        this.off("notification", onNotification);
        reject(new Error(`Timed out waiting for Codex turn ${turnID}`));
      }, timeoutMs);
      const finish = (callback) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (pollTimer) {
          clearTimeout(pollTimer);
        }
        this.off("notification", onNotification);
        callback();
      };
      const pollThread = async () => {
        if (settled) {
          return;
        }
        try {
          const turn = await this.readTurn(threadID, turnID);
          if (turn?.status === "failed") {
            finish(() => reject(new Error(stringifyError(turn.error))));
            return;
          }
          if (turnHasFinalAnswer(turn) || turn?.status === "completed" || turn?.status === "interrupted") {
            finish(() => resolve(turn));
            return;
          }
        } catch {
          // Keep waiting for the next notification or poll interval.
        }
        pollTimer = setTimeout(() => {
          pollThread().catch(() => {});
        }, 1000);
      };
      const onNotification = (message) => {
        const params = message.params ?? {};
        if (params.threadId !== threadID) {
          return;
        }
        if (message.method === "turn/completed" && params.turn?.id === turnID) {
          if (params.turn.status === "failed") {
            finish(() => reject(new Error(stringifyError(params.turn.error))));
          } else {
            finish(() => resolve(params.turn));
          }
        }
        if (message.method === "error" && !params.willRetry && params.turnId === turnID) {
          finish(() => reject(new Error(stringifyError(params.error))));
        }
      };
      this.on("notification", onNotification);
      pollThread().catch(() => {});
    });
  }
}

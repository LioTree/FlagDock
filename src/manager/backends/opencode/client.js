import { createAgentRuntime } from "@liontree/opencode-agent-sdk";
import { AGENT_NAME, CONTAINER_CHALLENGE_DIR } from "../../../constants.js";

export async function requireData(label, promise) {
  const response = await promise;
  if (response.error) {
    throw new Error(`${label} failed: ${JSON.stringify(response.error)}`);
  }
  if (response.data == null) {
    throw new Error(`${label} failed: empty response data`);
  }
  return response.data;
}

export async function createAttachedRuntime(serverUrl) {
  return createAgentRuntime({
    directory: CONTAINER_CHALLENGE_DIR,
    serverUrl,
  });
}

export async function listSessionMessages(runtime, sessionID, limit = 10) {
  // The agent SDK does not yet expose historical session messages.
  return requireData("session.messages", runtime.client.session.messages({
    sessionID,
    directory: runtime.directory,
    limit,
  }));
}

export async function readSessionInfo(runtime, sessionID) {
  return runtime.getSessionInfo(sessionID);
}

export async function waitForOpenCode(runtimeFactory, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const runtime = await runtimeFactory();
      await runtime.health();
      return runtime;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw lastError ?? new Error("Timed out waiting for OpenCode");
}

export function defaultSessionOptions() {
  return { agent: AGENT_NAME };
}

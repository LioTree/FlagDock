import { createAgentRuntime } from "@liontree/opencode-agent-sdk";
import { AGENT_NAME, CONTAINER_CHALLENGE_DIR } from "./constants.js";

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

export async function waitForOpenCode(runtimeFactory, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const runtime = await runtimeFactory();
      await requireData("global.health", runtime.client.global.health());
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

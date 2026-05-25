import { DEFAULT_MANAGER_HOST } from "../constants.js";
import { loadDaemonInfo } from "../state.js";

async function ping(info) {
  if (!info?.port) {
    return false;
  }
  try {
    const response = await fetch(`http://${info.host ?? DEFAULT_MANAGER_HOST}:${info.port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function managerInfo() {
  const info = await loadDaemonInfo();
  if (await ping(info)) {
    return info;
  }
  return null;
}

export async function request(method, pathname, body) {
  const info = await managerInfo();
  if (!info) {
    throw new Error("manager is not running; run `flagdock start` first");
  }
  const url = `http://${info.host ?? DEFAULT_MANAGER_HOST}:${info.port}${pathname}`;
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `${method} ${pathname} failed with ${response.status}`);
  }
  return payload;
}

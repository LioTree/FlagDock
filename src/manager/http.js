import { URL } from "node:url";

export function createHttpController({ workspaceRuntime, sessions, actions }, closeManager) {
  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) {
      return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function writeJson(response, statusCode, value) {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/status") {
      writeJson(response, 200, await workspaceRuntime.status());
      return;
    }
    if (request.method === "GET" && url.pathname === "/challenges") {
      await workspaceRuntime.refreshWorkspaceContainerStates();
      writeJson(response, 200, { challenges: await workspaceRuntime.configuredChallengeList() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/flags") {
      await workspaceRuntime.syncWorkspaceOutputs();
      writeJson(response, 200, { flags: await workspaceRuntime.configuredFlags() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/start") {
      writeJson(response, 200, await actions.startChallenge(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/start-all") {
      writeJson(response, 200, await actions.startAllChallenges(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/reset") {
      writeJson(response, 200, await actions.resetChallenge(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/reset-all") {
      writeJson(response, 200, await actions.resetAllChallenges());
      return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
      writeJson(response, 200, { sessions: await sessions.listSessions(url.searchParams.get("challenge"), url.searchParams.get("backend")) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/attach") {
      writeJson(response, 200, await sessions.attach(url.searchParams.get("challenge"), url.searchParams.get("session"), url.searchParams.get("backend")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/new") {
      writeJson(response, 200, await actions.newSession(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/mode/set") {
      writeJson(response, 200, await actions.setMode(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop") {
      writeJson(response, 200, await actions.stopWorkspace(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear") {
      writeJson(response, 200, await actions.removeWorkspace(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop-all") {
      writeJson(response, 200, await actions.stopAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear-all") {
      writeJson(response, 200, await actions.removeAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop-solved") {
      writeJson(response, 200, await actions.stopSolvedWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear-solved") {
      writeJson(response, 200, await actions.removeSolvedWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      writeJson(response, 200, { ok: true });
      setTimeout(() => closeManager().then(() => process.exit(0)), 20);
      return;
    }
    writeJson(response, 404, { error: "not found" });
  }

  return {
    readBody,
    writeJson,
    handleRequest,
  };
}

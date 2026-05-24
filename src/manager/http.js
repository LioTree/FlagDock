import { URL } from "node:url";

export const httpMethods = {
  async readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) {
      return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  },

  writeJson(response, statusCode, value) {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  },

  async handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      this.writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/status") {
      this.writeJson(response, 200, await this.status());
      return;
    }
    if (request.method === "GET" && url.pathname === "/challenges") {
      await this.refreshWorkspaceContainerStates();
      this.writeJson(response, 200, { challenges: await this.configuredChallengeList() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/start") {
      this.writeJson(response, 200, await this.startChallenge(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/start-all") {
      this.writeJson(response, 200, await this.startAllChallenges(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/reset") {
      this.writeJson(response, 200, await this.resetChallenge(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/reset-all") {
      this.writeJson(response, 200, await this.resetAllChallenges());
      return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
      this.writeJson(response, 200, { sessions: await this.listSessions(url.searchParams.get("challenge"), url.searchParams.get("backend")) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/attach") {
      this.writeJson(response, 200, await this.attach(url.searchParams.get("challenge"), url.searchParams.get("session"), url.searchParams.get("backend")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/new") {
      this.writeJson(response, 200, await this.newSession(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/mode/set") {
      this.writeJson(response, 200, await this.setMode(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop") {
      this.writeJson(response, 200, await this.stopWorkspace(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear") {
      this.writeJson(response, 200, await this.removeWorkspace(await this.readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop-all") {
      this.writeJson(response, 200, await this.stopAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear-all") {
      this.writeJson(response, 200, await this.removeAllWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/stop-solved") {
      this.writeJson(response, 200, await this.stopSolvedWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspace/clear-solved") {
      this.writeJson(response, 200, await this.removeSolvedWorkspaces());
      return;
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      this.writeJson(response, 200, { ok: true });
      setTimeout(() => this.close().then(() => process.exit(0)), 20);
      return;
    }
    this.writeJson(response, 404, { error: "not found" });
  }
};

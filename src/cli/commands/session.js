import { formatTimestamp } from "../../util.js";
import { request } from "../request.js";
import {
  lastArg,
  openUrl,
  parseOption,
  positionalArgs,
  printTable,
  runInteractive,
  truncate,
  usage,
} from "../support.js";

export async function showSessions(args) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  const backend = parseOption(args, "--backend");
  const query = new URLSearchParams({ challenge });
  if (backend) {
    query.set("backend", backend);
  }
  const { sessions } = await request("GET", `/sessions?${query}`);
  printTable(sessions, [
    { header: "backend", value: (row) => row.backend ?? "opencode" },
    { header: "session", value: (row) => row.session_id },
    { header: "role", value: (row) => row.role },
    { header: "source", value: (row) => row.source },
    { header: "mode", value: (row) => row.mode },
    { header: "status", value: (row) => row.status },
    { header: "error", value: (row) => truncate(row.last_error, 56) },
    { header: "created", value: (row) => formatTimestamp(row.created_at) },
  ]);
}

export async function attach(args) {
  const positions = positionalArgs(args, ["--backend", "--session"]);
  if (positions.length > 1) {
    throw new Error(usage());
  }
  const challenge = positions[0] ?? null;
  const backend = parseOption(args, "--backend");
  const session = parseOption(args, "--session");
  const query = new URLSearchParams();
  if (challenge) {
    query.set("challenge", challenge);
  }
  if (backend) {
    query.set("backend", backend);
  }
  if (session) {
    query.set("session", session);
  }
  const result = await request("GET", `/attach?${query}`);
  if (result.mode === "list") {
    printTable(result.attach ?? [], [
      { header: "challenge", value: (row) => row.challenge },
      { header: "backend", value: (row) => row.backend },
      { header: "session", value: (row) => row.session },
      { header: "role", value: (row) => row.role },
      { header: "status", value: (row) => row.status },
      { header: "attach", value: (row) => row.attach },
    ]);
    return;
  }
  if (result.backend === "codex") {
    await runInteractive(result.argv);
    return;
  }
  console.log(result.url);
  openUrl(result.url);
}

export async function newSession(args) {
  const challenge = args[0];
  if (!challenge) {
    throw new Error(usage());
  }
  const backend = parseOption(args, "--backend");
  const mode = parseOption(args, "--mode") ?? "auto";
  const { session } = await request("POST", "/session/new", { challenge, mode, backend });
  console.log(`${session.session_id} mode=${session.mode} url=${session.url}`);
}

export async function setMode(args) {
  const challenge = args[0];
  const session = parseOption(args, "--session");
  const backend = parseOption(args, "--backend") ?? "opencode";
  const mode = lastArg(args);
  if (!challenge || !session || !mode || mode === session) {
    throw new Error(usage());
  }
  const result = await request("POST", "/mode/set", { challenge, session, mode, backend });
  console.log(`${result.session.session_id} mode=${result.session.mode}`);
}

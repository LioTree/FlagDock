import { spawn } from "node:child_process";

export function usage() {
  return `Usage:
  flagdock start
  flagdock stop
  flagdock status
  flagdock challenges
  flagdock flags watch
  flagdock challenge start <challenge> [--mode auto|manual]
  flagdock challenge start --all [--mode auto|manual]
  flagdock challenge reset <challenge>
  flagdock challenge reset --all
  flagdock sessions <challenge> [--backend opencode|codex]
  flagdock attach [challenge] [--backend opencode|codex] [--session <session_id>]
  flagdock session new <challenge> [--backend opencode|codex] [--mode auto|manual]
  flagdock mode set <challenge> [--backend opencode|codex] --session <session_id> auto|manual
  flagdock workspace stop <challenge>
  flagdock workspace stop --all
  flagdock workspace stop --solved
  flagdock workspace clear <challenge>
  flagdock workspace clear --all
  flagdock workspace clear --solved`;
}

export function parseOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

export function lastArg(args) {
  return args[args.length - 1];
}

export function isAllScope(args) {
  return args.length === 1 && args[0] === "--all";
}

export function isSolvedScope(args) {
  return args.length === 1 && args[0] === "--solved";
}

export function hasFlag(args, name) {
  return args.includes(name);
}

export function positionalArgs(args, valueOptions = []) {
  const optionsWithValues = new Set(valueOptions);
  const positions = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    positions.push(arg);
  }
  return positions;
}

export function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const widths = columns.map((column) => Math.max(
    column.header.length,
    ...rows.map((row) => String(column.value(row) ?? "").length),
  ));
  console.log(columns.map((column, index) => column.header.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => String(column.value(row) ?? "").padEnd(widths[index])).join("  "));
  }
}

export function truncate(value, max = 64) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function openUrl(url) {
  if (!url) {
    return;
  }
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printing the URL is the reliable path; opening it is best-effort.
  }
}

export async function runInteractive(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("attach command is missing argv");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${argv[0]} exited with ${code}`));
    });
  });
}

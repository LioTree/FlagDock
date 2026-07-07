import { request } from "../request.js";
import { hasFlag, positionalArgs, usage } from "../support.js";

function flagKey(item) {
  return `${item.challenge}\0${item.backend}\0${item.flag}`;
}

function printFlag(item) {
  console.log(`${new Date().toISOString()} ${item.challenge} ${item.backend} ${item.flag}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollFlags(fetchFlags, seen, output = printFlag) {
  const result = await fetchFlags();
  let printed = 0;
  for (const item of result.flags ?? []) {
    const key = flagKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output(item);
    printed += 1;
  }
  return printed;
}

export async function watchFlags(args) {
  const positions = positionalArgs(args);
  if (positions.length > 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    throw new Error(usage());
  }

  const seen = new Set();
  while (true) {
    try {
      await pollFlags(() => request("GET", "/flags"), seen);
    } catch (error) {
      console.error(`flags watch poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(1000);
  }
}

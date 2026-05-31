import { readSessionPrompt } from "../../prompts.js";
import { nowIso } from "../../util.js";

export function normalizeAutoPromptKind(kind) {
  if (kind === "initial" || kind === "writeup") {
    return kind;
  }
  return "continue";
}

export async function beginAutoPromptTurn(context, services, workspace, backend, sessionID, kind, session = null) {
  const promptKind = normalizeAutoPromptKind(kind);
  const prompt = await readSessionPrompt(promptKind);
  const current = session ?? services.sessions.sessionRegistry(workspace, backend, sessionID);
  services.sessions.updateSessionRegistry(workspace, backend, sessionID, {
    last_auto_prompt_at: nowIso(),
    last_auto_prompt_kind: promptKind,
    status: "active",
    ...(promptKind === "writeup" ? { writeup_prompt_sent_at: current?.writeup_prompt_sent_at ?? nowIso() } : {}),
  });
  await context.save();
  await context.log(`sending ${promptKind} prompt to ${backend} ${workspace.challenge}/${sessionID}`);
  return { promptKind, prompt, session: current };
}

export async function finishAutoPromptTurn(context, services, workspace, backend, sessionID, values = {}) {
  await services.workspaceRuntime.syncBackendOutputs(workspace, backend);
  const solved = (await services.workspaceRuntime.workspaceChallengeInfo(workspace)).solved;
  await services.workspaceRuntime.reconcileSolvedBy(workspace);
  services.sessions.updateSessionRegistry(workspace, backend, sessionID, {
    ...values,
    last_response_at: nowIso(),
    last_error: "",
    status: solved ? "completed" : "idle",
  });
  await context.save();
}

import { readSessionPrompt } from "../../prompts.js";
import { nowIso } from "../../util.js";

export async function beginAutoPromptTurn(manager, workspace, backend, sessionID, kind, session = null) {
  const promptKind = manager.promptKind(kind);
  const prompt = await readSessionPrompt(promptKind);
  const current = session ?? manager.sessionRegistry(workspace, backend, sessionID);
  manager.updateSessionRegistry(workspace, backend, sessionID, {
    last_auto_prompt_at: nowIso(),
    last_auto_prompt_kind: promptKind,
    status: "active",
    ...(promptKind === "writeup" ? { writeup_prompt_sent_at: current?.writeup_prompt_sent_at ?? nowIso() } : {}),
  });
  await manager.save();
  await manager.log(`sending ${promptKind} prompt to ${backend} ${workspace.challenge}/${sessionID}`);
  return { promptKind, prompt, session: current };
}

export async function finishAutoPromptTurn(manager, workspace, backend, sessionID, values = {}) {
  await manager.syncBackendOutputs(workspace, backend);
  const solved = (await manager.workspaceChallengeInfo(workspace)).solved;
  await manager.reconcileSolvedBy(workspace);
  manager.updateSessionRegistry(workspace, backend, sessionID, {
    ...values,
    last_response_at: nowIso(),
    last_error: "",
    status: solved ? "completed" : "idle",
  });
  await manager.save();
}

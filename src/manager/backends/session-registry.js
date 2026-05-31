import { CONTAINER_CHALLENGE_DIR } from "../../constants.js";
import { nowIso } from "../../util.js";
import { sessionCollection } from "../helpers.js";

export function managedSessionFields(backend, workspace, existing, { role, mode, createdAt = null }) {
  return {
    backend,
    challenge: workspace.challenge,
    directory: CONTAINER_CHALLENGE_DIR,
    role,
    source: "managed",
    mode,
    created_at: existing.created_at ?? createdAt ?? nowIso(),
    last_seen_at: nowIso(),
    last_auto_prompt_at: existing.last_auto_prompt_at,
    last_auto_prompt_kind: existing.last_auto_prompt_kind,
    last_response_at: existing.last_response_at,
    writeup_prompt_sent_at: existing.writeup_prompt_sent_at,
    last_error: existing.last_error ?? "",
  };
}

export async function ensurePrimarySession(workspaceRuntime, workspace, backend, mode, createPrimary) {
  const backendState = workspaceRuntime.ensureBackendState(workspace, backend);
  let primary = backendState.primarySessionId ? sessionCollection(backendState)[backendState.primarySessionId] : null;
  if (!primary) {
    primary = await createPrimary(backendState);
    backendState.primarySessionId = primary.session_id;
  } else {
    primary.mode = mode;
  }
  return primary;
}

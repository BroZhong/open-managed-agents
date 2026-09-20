import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";

const CONTINUATION = "oma.continuation";
export function isContinuationEntry(entry: SessionEntry): boolean {
  return entry.type === "custom_message" && entry.customType === CONTINUATION;
}

/** Trigger public prompt settlement, then detach the empty transport marker. */
export function installContinuation(session: AgentSession): () => Promise<void> {
  const keep = (message: { role: string; customType?: string }) => !(message.role === "custom" && message.customType === CONTINUATION);
  // Agent listeners are awaited in registration order. AgentSession's own
  // listener has appended the marker before this callback; steering has not run.
  session.agent.subscribe(event => {
    if (event.type !== "message_end" || keep(event.message)) return;
    const leaf = session.sessionManager.getLeafEntry();
    if (!leaf || !isContinuationEntry(leaf)) throw new Error("Continuation marker was not appended at the expected boundary");
    if (leaf.parentId) session.sessionManager.branch(leaf.parentId);
    else session.sessionManager.resetLeaf();
    session.agent.state.messages = session.agent.state.messages.filter(keep);
  });
  const convert = session.agent.convertToLlm;
  session.agent.convertToLlm = messages => convert(messages.filter(keep));
  return () => session.sendCustomMessage({ customType: CONTINUATION, content: [], display: false }, { triggerTurn: true });
}

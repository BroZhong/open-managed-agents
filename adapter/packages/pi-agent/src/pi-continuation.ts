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
  // A resumed Turn can end in the failed request of the attempt that was lost,
  // and this attempt's own request can fail after it. Pi's retry and overflow
  // recovery drop one failed request from the context before they continue,
  // and Pi refuses to continue from an assistant message. A failed or aborted
  // request never reaches the provider, so every trailing one leaves the
  // context first; the session tree, and so the durable history, keeps them.
  const agentContinue = session.agent.continue.bind(session.agent);
  session.agent.continue = () => {
    const messages = session.agent.state.messages;
    let end = messages.length;
    while (end > 0 && isFailedRequest(messages[end - 1])) end--;
    if (end < messages.length) session.agent.state.messages = messages.slice(0, end);
    return agentContinue();
  };
  return () => session.sendCustomMessage({ customType: CONTINUATION, content: [], display: false }, { triggerTurn: true });
}

export function isFailedRequest(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

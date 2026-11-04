import { presentEvent } from "@oma-server/store";

/**
 * The tool calls of one Turn attempt whose results are not committed yet,
 * and which of them hold a durable delegation wait (#330, ADR-0026).
 *
 * A Turn whose every such call waits on a Child Session executes nothing
 * itself: it gives up its slot of the Runner Capacity, and a Runner that
 * shuts down hands it over at once, since the next owner resumes each wait
 * from its record. The judgement is of committed state, not of what still
 * runs: Pi commits the results of parallel calls together once the last
 * one ends, so a call that finished beside a wait is uncommitted until the
 * wait ends too, and a takeover would report it as of unknown outcome. Such
 * a Turn keeps its slot and hands over at its next model request.
 */
export class InFlightCalls {
  /** By call id: whether the call holds a durable wait. */
  private readonly calls = new Map<string, boolean>();
  private waiting = false;

  /** `changed` hears each flip of {@link waitingOnly}. */
  constructor(private readonly changed: (waitingOnly: boolean) => void) {}

  /** Only delegation waits are in flight: at least one call, and every one waiting. */
  get waitingOnly(): boolean {
    return this.waiting;
  }

  /**
   * An event the attempt committed: the calls it makes and those it
   * answers. Native entries count through their display blocks, as for
   * dangling calls, so an aborted assistant entry's unexecuted call is made
   * and answered at once.
   */
  committed(event: { type: string; data: unknown }): void {
    const displayed = presentEvent(event);
    for (const { type, data } of displayed) {
      const toolUseId = (data as { toolUseId?: unknown } | null)?.toolUseId;
      if ((type === "agent.tool_use" || type === "agent.mcp_tool_use") && typeof toolUseId === "string" && !this.calls.has(toolUseId)) {
        this.calls.set(toolUseId, false);
      }
    }
    for (const { type, data } of displayed) {
      const toolUseId = (data as { toolUseId?: unknown } | null)?.toolUseId;
      if ((type === "agent.tool_result" || type === "agent.mcp_tool_result") && typeof toolUseId === "string") this.calls.delete(toolUseId);
    }
    this.update();
  }

  /**
   * The call waits on its durable delegation wait, from now until its result
   * is committed: also once the wait has returned, since the record stays
   * until the result consumes it and a takeover reads the result from it.
   */
  waits(toolUseId: string): void {
    this.calls.set(toolUseId, true);
    this.update();
  }

  private update(): void {
    const waiting = this.calls.size > 0 && [...this.calls.values()].every(Boolean);
    if (waiting === this.waiting) return;
    this.waiting = waiting;
    this.changed(waiting);
  }
}

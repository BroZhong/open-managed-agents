# ADR-0010: Host-owned durable delegation

## Status

[ADR-0017](0017-sandbox-idle-reclamation.md) adds non-expiring activity records
for controlled Sandbox lifecycle management. Execution resource-use leases still
fence work, but expiry is not evidence that remote execution has stopped and
cannot authorize reclamation of a managed binding.

Accepted. Supersedes ADR-0006's plugin delegation, shared parent ToolExecutor,
private usage bridge and parent-scoped child lifetime. Retains ADR-0002/0003's
Host/Adapter boundary and ADR-0009's concurrent Workspace write semantics.

## Context

A parent Pi instance can finish or disappear while delegated work is running.
Plugin memory, temporary IDs and parent lifecycle callbacks cannot represent a
recoverable Child Session, an exact synchronous wait, or a durable result input.
Delegation must therefore use the same persistent Session and Turn execution
machinery as ordinary input, while preserving who accepted each operation.

## Decision

### 1. Persistent Sessions and execution associations

The Host owns `Agent`, `get_subagent_result` and `steer_subagent`. The Adapter
receives bound capability objects per Turn; model arguments cannot supply a
Tenant, calling Session, Turn or lease owner. There is no required business
subtype. The supported optional subtype is `general-purpose`. `worktree`,
`isolated` and unknown authority parameters are rejected.

A new delegation atomically creates a Child Session, its durable input and an
execution association. The child belongs to the parent's Tenant and configured
Agent. Its creation parent Session/Turn/tool-use identity never changes. Resume
creates a new execution association and input in the same Child Session and
records that call's identity separately. The same calling tool ID is idempotent.

Supabase PostgreSQL is authoritative. The implementation stores coordination
records in `delegation_executions`, `delegation_waits`, `delegation_commands` and
`delegation_resource_uses`, and Sandbox identity in `delegation_environments`.
Coordination writes use SQL transactions with the existing Session, pending
input and Complete Event records. A database row lock currently serializes
coordination transactions, including quota admission. This favors consistency
over high coordination throughput; it can be partitioned after measuring load.
The in-memory store is a development/test implementation, not crash durability.

### 2. One scheduler and independent capabilities

Child Delegation Inputs enter the ordinary pending input queue and are driven
by the Session Router. A Child Session executes one Turn at a time. Parent child
concurrency defaults to four; excess inputs remain durable and queued. A parent
waiting for a result does not occupy a child execution slot.

Each accepted Delegation Input snapshots the calling parent Turn's resolved
provider/model, including on resume, and pins it through queueing and recovery.
The child constructs its own Pi session, ModelRuntime and per-Turn ToolExecutor
using that model. The model cannot override it through tool arguments. No
predefined subagent configuration exists yet; a future explicitly configured
subagent model would require a separate Host-owned policy. Thinking overrides
are validated and the effective configuration is recorded;
credentials and capability objects are not persisted. The default child budget
is 500 model requests, assigned by the Host for each new or resumed execution.
The parent cannot override the budget through tool arguments. Exhaustion returns
`budget_exhausted`; the parent decides whether to resume with a fresh budget.
There is no automatic budget retry. The Host configuration remains bounded at 1000. Pi retains its
normal retry and compaction behavior. Promise settlement alone is not success:
final provider errors, Interrupt, budget exhaustion and recovery uncertainty
produce distinct outcomes. Incomplete streamed tool arguments are recorded as
an unexecuted failed call; a later Turn does not replay them.

Children expose only `bash`, `read`, `write`, `edit`, `ls`, `grep` and `find`, all
through their own Sandbox executor. A missing executor fails closed. They do
not inherit Web/MCP, Host-native tools, nested delegation, or ambient Skills.
Host-selected system instructions and Skill descriptions may be inherited;
Skill bodies are read from their Sandbox projections. The parent conversation
is not copied by default. Each child's full Complete Events and usage belong
to its child Turn and retain the initiating API key association. No second
parent-side usage bridge duplicates that accounting.

### 3. Stable Workspace and Sandbox binding

A child retains its creation Workspace and Sandbox binding across resumes.
Each executing parent or child acquires an independent resource-use lease tied
to its pending input owner and generation. Parent cleanup releases only that
parent's use; the Sandbox remains available to other valid users. Database
coordination stores the shared Sandbox identity so a later owner can attach
instead of depending on a former process's Pi or Sandbox object.

All commands and file operations check the current execution lease before using
resources. An expired owner cannot commit results, acknowledge commands or start
new resource operations. This does not claim that an already-running external
command can be rolled back. A successfully closed Workspace file remains saved
regardless of Turn outcome. Concurrent writes can overwrite each other, as in
ADR-0009; sharing a Sandbox does not promise file isolation.

### 4. Synchronous waiting resumes the same Turn

`Agent` defaults to `run_in_background=false`; explicit true/false and resume
use the same rule. `get_subagent_result(wait=false)` reads immediately, while
`wait=true` waits on the selected execution, including while it is queued.

A wait stores the original parent Turn, calling tool ID, selected execution and
a structured checkpoint of current-Turn Complete Events. The Adapter captures
these events synchronously before invoking the Host capability, closing the
race where the tool callback runs before the Router consumes its event queue.
Checkpoint events retain their IDs and are idempotently restored to history.

The Host retains the original pending input and Turn identity through waiting.
On recovery it commits the result for the original tool, reconstructs complete
structured history and asks Pi to continue without adding another user prompt.
The Adapter refuses continuation with any unresolved tool request and never
re-executes completed tools. ADR-0014 uses a non-model custom control message through the public SDK to enter
the same retry/compaction settlement loop used by normal prompts.
The Host restores the model-step count for that same Turn.

Result consumption and the durable parent tool result share one transaction.
Losing a temporary Promise does not consume a result. A cancelled wait does not
become a successful result, and queued user inputs remain behind the active Turn.

### 5. Asynchronous result outbox

A child terminal outcome, parent result notification and asynchronous pending
input commit together. Identity is the execution, not merely the Child Session,
so later resumes produce distinct results and duplicate publication is harmless.
Wake signals accelerate delivery; scanning database pending inputs recovers a
missed signal. An active parent queues the result behind accepted inputs.

The immediate `subagent.result` notification is visible to users but is never
injected into an earlier model context. Claiming its pending input emits
`subagent.result_claimed`, and only that claimed source enters reconstructed
history. Parent result handling uses a new Turn, unlike synchronous waiting.
Tool consumption suppresses an unclaimed automatic result input only after its
parent tool result is durable. Terminated parents retain results without being
automatically awakened. Synchronous executions do not create an extra parent
model Turn.

### 6. Durable steering and Interrupt

Steering binds a command to one queued/running execution. The Host persists the
command before returning `accepted`; the owning child applies it at a model
request boundary and records `subagent.instruction` with its instruction ID.
History and command acknowledgement are idempotent under the owner's lease.
Canonical history keeps the delegation source; model context labels it as a
delegation instruction. Accepted commands that lose a completion race become
`not_applied`, and never silently move to the next resume. A terminal child
requires a new resume input.

Interrupt targets an active Turn/execution, with durable command and owner
generation. Interrupting a synchronous parent stops synchronous executions that
that Turn created/resumed; it only cancels a query wait on an independent
asynchronous execution. Other asynchronous children and later queued inputs
continue. Accepted and actually applied interruption are distinct states.

### 7. Recovery is explicit about external uncertainty

Unstarted durable inputs can be claimed by a new owner. A waiting parent can
resume its original Turn because the Host owns the pending tool/result protocol.
An abandoned child execution that may have performed external operations is
finished as `recovery_required`, releasing its execution slot and producing an
honest result. It is not reported completed or blindly replayed. The user or a
later resumed child can inspect the trace, files and external task identifiers
before continuing. This is recoverable coordination, not exactly-once external
side effects.

## Migration and consequences

Deployment stops accepting old plugin work, drains active old parent Turns and
then starts the new Host. The normal images no longer install or patch a Pi
subagent plugin or seed a storyboard Agent type. A Turn has one delegation tool
registration source. Old canonical history remains readable; old temporary
plugin child IDs receive a clear unknown/legacy result rather than a fabricated
persistent Session.

API and UI queries expose creation origin and each execution separately, scoped
to the Tenant. Parent tool cards link to child traces and retain exact execution
identity through resume, refresh and reconnect. Child output and saved files
are evidence of work performed; neither implies artifact acceptance.

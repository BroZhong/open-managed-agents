# FastClaw Frontend Reference (for the MVP console)

Captured from the live console at https://cloud.fastclaw.ai on 2026-07-05.
Screenshots in this folder: `fc_agents.png`, `fc_chat.png`, `fc_edit2.png`, `fc_workspace.png`.

We are matching FastClaw's **look and interaction**, not copying its data model.
Our model stays: enter through an Agent → an Agent owns many Sessions → a Session
has Turns + a Workspace. FastClaw calls a Session a "chat".

## Visual language

- Warm, minimal, lots of whitespace. Off-white background, white cards.
- Single accent color: a burnt-orange / terracotta (primary buttons, active icons,
  the agent avatar tile). Everything else is neutral grey/black text.
- Rounded corners throughout (cards, inputs, buttons, avatar tiles ~`rounded-xl`).
- Icons: Lucide. Agent avatar is a rounded square with a bot glyph on a tinted
  orange background when no image is set.
- Primary action button = solid orange with white text (e.g. "New Agent", "Save",
  the send button). Secondary = plain text/ghost ("Cancel", "Edit"). Destructive =
  red text with trash icon ("Remove").

## Two navigation contexts (important)

The left sidebar **changes based on where you are**:

1. **Global context** (Agents list, `fc_agents.png`): sidebar shows
   `Overview / Agents / Models` under an "Agent" group, `API Keys` under a "User"
   group, then `Settings` and the user chip at the bottom.

2. **Agent context** (inside a chat, `fc_chat.png`): the sidebar's top switches to
   the **current agent** (name + a chevron switcher to jump agents). Below:
   - `+ New chat`
   - `Projects` group (collapsible, `+` to add) — chats can be grouped into projects.
   - `Chats` group — the flat list of this agent's sessions.
   The bottom still has `Settings` + user chip.

   → This is our "an Agent owns many Sessions" made concrete. **Projects** is an
   optional grouping layer over Sessions; treat it as post-MVP unless cheap.

## Agents list page (`fc_agents.png`)

- Title "Agents" + subtitle "Manage your AI agents and their configurations".
- `+ New Agent` primary button top-right.
- Each agent = a card: avatar tile, name, monospace `agt_...` id, a one-line
  description/system preview, a `Private`/`Public` pill top-right, and a footer
  row with `Edit` (pencil) and `Remove` (red trash).
- Clicking the card body opens the agent's **chat** (`/agents/{id}/chat/`), not an
  edit form. Editing is a separate modal.

## Edit / New Agent modal (`fc_edit2.png`)

- Centered modal card, `×` close top-right.
- Header "Edit Agent" + "ID is locked — `agt_...`" (id shown, not editable).
- Fields: **avatar** (click to upload), **Name** (input), **Description**
  (textarea), **Public access** (toggle with helper text "Only you can use this
  agent.").
- Footer: `Cancel` (ghost) + `Save` (orange).
- NOTE: model / system-prompt / skills are **not** in this modal on cloud. Those
  live elsewhere (chat-side, via SOUL-style files). For our MVP the Agent detail
  page carries the fuller config + Agent Files editor + Equip panel — we do not
  have to hide config the way cloud does.

## Agent Settings — the real config center (`fc_agent_settings.png`)

Clicking **Settings** (bottom of the sidebar while in an Agent) opens a large modal
with a **left grouped nav**. This is where the config the Edit modal hides actually
lives:

- **AGENT group:** Profile · Customize · Models · Context · Skills · MCP · Plugins ·
  Channels · Scheduler · Token Usage
- **USER group:** Account · General

Each entry swaps the right pane. `×` closes; each pane has its own `Save`.

→ Our Agent detail page = this modal's AGENT group, **minus** the items we cut
(MCP, Plugins, Channels, Scheduler, Token Usage). Visually we'll be "the same nav
with fewer rows". Our MVP panes: **Profile**, **Customize** (+ **Context**) =
Agent Files editor, **Models** (or fold model into Profile), **Skills** = Equip.

## Customize — the Agent Files editor to replicate (`fc_customize.png`)

Subtitle "Personality, memory, and behavior files for {agent}". A **horizontal tab
row**, one tab per Agent File: **Soul · Identity · User · Tools · Bootstrap ·
Heartbeat · Memory · Agents**. Each tab shows a single large markdown editor
(placeholder `# SOUL.md` / "Write your content here...") with a top-right `Save`.

→ This is exactly our multi-tab Agent Files editor (Step 6). MVP keeps **Soul,
Identity, User, Memory**; drop Tools/Bootstrap/Heartbeat/Agents (FastClaw-specific).
FastClaw splits identity-ish files (Customize) from context-ish files (a separate
**Context** pane) — we can mirror that grouping or keep one tab row.

## Skills pane — NOTE a model difference (`fc_agent_skills.png`)

FastClaw cloud's per-agent Skills pane is "**Skills scoped to {agent} — only this
agent sees them**", with **Upload Skills** / **Install Skill** actions; empty state
says an installed skill "lands in this agent's own skills directory and only this
agent sees it". i.e. **cloud treats Skills as agent-private uploads**, with a shared
catalog reachable only via "Install Skill" (from ClawHub).

**We deliberately diverge.** Our model (per CONTEXT.md) is a **tenant-scoped Skill
Library** + **many-to-many Equip**:
- Uploading a Skill happens on the **global entry page** (layout 甲), into the shared
  Library — not per agent.
- The Agent's Skills pane is an **Equip picker**: check which Library Skills this
  Agent uses. Equipping references, never copies.

Borrow the pane's *chrome* (title + top-right actions + empty-state card) but make
the body a checklist of Library skills, not a private uploader.

## Chat page (`fc_chat.png`)

- Header "Chat with {agent}", a sidebar-toggle icon left, a **Show workspace**
  folder icon top-right.
- Empty state: large centered "What can I do for you?".
- Composer: rounded box, placeholder **`Message {agent}... ("/" to pick a skill)`**
  — skills are invoked inline by typing `/`. Paperclip = attach/upload. Round
  orange send button.

## Workspace panel (`fc_workspace.png`)

- Opens as a **right-hand split pane** (not a separate route/tab): chat stays on
  the left, Workspace on the right.
- Header "Workspace" (folder icon) + toolbar: download, new-folder, refresh, close.
- Left column "Files" tree — empty state "No files in this session yet."
  (per-session wording confirms Workspace is Session-scoped).
- Right column file preview — empty state "Select a file to view it here."
- Our current Session detail has this as a "Workspace" tab; consider matching the
  side-by-side split for parity, or keep the tab for MVP simplicity.

## Takeaways for our MVP steps

- **Step 5/6 (entry page, layout 甲):** global sidebar with Agents + a Skill
  Library area. Agent cards mirror `fc_agents.png`. New/Edit Agent as a modal like
  `fc_edit2.png` but with our fuller fields.
- **Step 6 (Agent detail):** on entering an Agent, switch the sidebar to Agent
  context (agent name + New chat + this agent's Session list), matching `fc_chat.png`.
  Equip-skills + Agent Files editing live on this page.
- **Step 7 (nav):** the two-context sidebar swap is the core interaction to
  replicate — global list vs. in-agent session list.
- Skills are surfaced to the end user via `/` in the composer; equipping is a
  config action on the Agent page. Keep both.

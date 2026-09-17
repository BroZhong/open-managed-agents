import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { ConversationView } from "@/components/conversation-view";
import { apiFetch } from "@/lib/api";
import type { SessionEvent } from "@/lib/types";

export function SessionShareDialog({ sessionId, title, events, loading, loadError }: { sessionId: string; title: string; events: SessionEvent[]; loading?: boolean; loadError?: string }) {
  const [open, setOpen] = useState(false);
  const [shareId, setShareId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  async function copyLink() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setCopied(false);
    try {
      const id = shareId ?? (await apiFetch<{ id: string }>(`/v1/sessions/${encodeURIComponent(sessionId)}/share`, { method: "POST" })).id;
      setShareId(id);
      await navigator.clipboard.writeText(`${window.location.origin}/share/${encodeURIComponent(id)}`);
      setCopied(true);
    } catch {
      setError("无法生成或复制链接，请重试。");
    } finally { setBusy(false); }
  }
  return <>
    <Button variant="outline" onClick={() => { setCopied(false); setError(undefined); setOpen(true); }}><Share2 size={14} />分享</Button>
    <Dialog open={open} onOpenChange={setOpen} ariaLabel="分享 Session">
      <DialogHeader><h2 className="text-lg font-semibold">{title}</h2></DialogHeader>
      <div className="share-preview" inert aria-label="对话预览">
        <ConversationView preview loading={loading} loadError={loadError} events={events} sessionStatus="idle" resources={{ shared: true, agentId: "", skills: [] }} />
      </div>
      <p className="mt-4 text-sm text-[var(--color-fg-muted)]">任何拥有此链接的人都可以只读查看此 Session 和整个 Workspace。后续消息和文件更新也会在刷新后显示。</p>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}
      <DialogFooter><Button disabled={busy} onClick={() => void copyLink()}>{busy ? "正在复制…" : copied ? "已复制" : "复制链接"}</Button></DialogFooter>
    </Dialog>
  </>;
}

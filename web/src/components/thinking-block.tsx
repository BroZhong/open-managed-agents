import { Brain } from "lucide-react";
import { SessionDisclosure } from "@/components/session-disclosure";

export function ThinkingBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <SessionDisclosure className="session-thinking" defaultOpen={streaming} active={streaming} summary={<><Brain size={14} /><span>{streaming ? "Thinking…" : "Reasoning"}</span></>}>
      <p className="session-reasoning-text">{text}</p>
    </SessionDisclosure>
  );
}

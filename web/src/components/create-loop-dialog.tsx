import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateLoop } from "@/lib/hooks/use-loops";

export function CreateLoopDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createLoop = useCreateLoop();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(5);

  function resetForm() {
    setName("");
    setDescription("");
    setPrompt("");
    setIntervalMinutes(5);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  const valid = Boolean(
    name.trim() &&
      prompt.trim() &&
      Number.isInteger(intervalMinutes) &&
      intervalMinutes >= 5,
  );
  function submit() {
    if (!valid) return;
    createLoop.mutate(
      {
        agentId,
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        intervalMinutes,
        enabled: true,
      },
      {
        onSuccess: () => {
          toast.success("Loop created");
          handleOpenChange(false);
        },
        onError: (error) => toast.error(error.message || "Failed to create Loop"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} ariaLabel="New Loop">
      <form
        aria-label="New Loop"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogHeader>
          <h2 className="text-lg font-semibold">New Loop</h2>
          <p className="text-sm text-neutral-500">
            Start a fresh Session automatically on a recurring interval.
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1.5 text-sm font-medium text-neutral-700">
            <span>Name</span>
            <Input
              autoFocus
              aria-label="Loop name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium text-neutral-700">
            <span>Description</span>
            <Input
              aria-label="Loop description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <Textarea
            label="Prompt"
            id="loop-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
          />
          <label className="block space-y-1.5 text-sm font-medium text-neutral-700">
            <span>Repeat every (minutes)</span>
            <Input
              aria-label="Repeat every (minutes)"
              type="number"
              min={5}
              step={1}
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            />
          </label>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || createLoop.isPending}>
            {createLoop.isPending ? "Creating…" : "Create Loop"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

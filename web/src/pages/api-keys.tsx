import { useState } from "react"
import { Plus, Trash2, Copy, Key } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Dialog, DialogHeader, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
  type ApiKeyCreateResponse,
} from "@/lib/hooks/use-api-keys"

export default function ApiKeysPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
  } | null>(null)

  return (
    <div>
      <PageHeader title="API Keys">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Key
        </Button>
      </PageHeader>

      <ApiKeysList onDelete={(id, name) => setDeleteTarget({ id, name })} />

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />

      <DeleteKeyDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      />
    </div>
  )
}

function ApiKeysList({
  onDelete,
}: {
  onDelete: (id: string, name: string) => void
}) {
  const { data: keys, isLoading } = useApiKeys()

  if (isLoading) {
    return (
      <div className="px-6 py-4">
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-md bg-neutral-100"
            />
          ))}
        </div>
      </div>
    )
  }

  if (!keys || keys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <Key className="mb-3 h-10 w-10 text-neutral-300" />
        <p className="text-neutral-500">
          No API keys yet. Create one to get started.
        </p>
      </div>
    )
  }

  return (
    <div className="px-6 py-4">
      <table className="w-full">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">
            <th className="pb-3 pr-4">Name</th>
            <th className="pb-3 pr-4">Key</th>
            <th className="pb-3 pr-4">Created</th>
            <th className="pb-3 w-10" />
          </tr>
        </thead>
        <tbody>
          {keys.map((apiKey) => (
            <tr
              key={apiKey.id}
              className="border-b border-neutral-100 last:border-0"
            >
              <td className="py-3 pr-4 text-sm font-medium text-neutral-900">
                {apiKey.name}
              </td>
              <td className="py-3 pr-4">
                <code className="rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-600">
                  {apiKey.prefix}...••••
                </code>
              </td>
              <td className="py-3 pr-4 text-sm text-neutral-500">
                {formatDate(apiKey.createdAt)}
              </td>
              <td className="py-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(apiKey.id, apiKey.name)}
                  aria-label={`Delete ${apiKey.name}`}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CreateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState("")
  const [createdKey, setCreatedKey] = useState<ApiKeyCreateResponse | null>(
    null
  )
  const createMutation = useCreateApiKey()

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("")
      setCreatedKey(null)
      createMutation.reset()
    }
    onOpenChange(value)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createMutation.mutate(
      { name: name.trim() },
      {
        onSuccess: (data) => {
          setCreatedKey(data)
        },
        onError: (error) => {
          toast.error(error.message)
        },
      }
    )
  }

  const handleCopy = async () => {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey.key)
      toast.success("API key copied to clipboard")
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }

  if (createdKey) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogHeader>
          <h2 className="text-lg font-semibold text-neutral-900">
            API Key Created
          </h2>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={createdKey.key}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="icon" onClick={handleCopy}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm font-medium text-amber-600">
            Make sure to copy your API key now. You won't be able to see it
            again!
          </p>
        </div>

        <DialogFooter>
          <Button onClick={() => handleClose(false)}>Done</Button>
        </DialogFooter>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogHeader>
        <h2 className="text-lg font-semibold text-neutral-900">
          Create API Key
        </h2>
        <p className="text-sm text-neutral-500">
          Give your key a name to identify it later.
        </p>
      </DialogHeader>

      <form onSubmit={handleSubmit}>
        <Input
          placeholder="e.g., CI Pipeline, Development"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => handleClose(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!name.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function DeleteKeyDialog({
  target,
  onOpenChange,
}: {
  target: { id: string; name: string } | null
  onOpenChange: (open: boolean) => void
}) {
  const deleteMutation = useDeleteApiKey()

  const handleConfirm = () => {
    if (!target) return
    deleteMutation.mutate(target.id, {
      onSuccess: () => {
        toast.success(`API key "${target.name}" deleted`)
      },
      onError: (error) => {
        toast.error(error.message)
      },
    })
  }

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title="Delete API Key"
      description="Are you sure? This action cannot be undone. If this is the key you're currently using, you'll be logged out."
      onConfirm={handleConfirm}
      confirmLabel="Delete"
    />
  )
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

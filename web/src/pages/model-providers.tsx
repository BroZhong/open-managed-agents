import { useState } from "react";
import { Plus, Pencil, Trash2, CheckCircle2, Server } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  useModelProviders,
  useProviderProtocols,
  useDiscoverProviderModels,
  useTestProvider,
  useSaveProvider,
  useDeleteProvider,
  type ModelProvider,
  type ProviderInput,
  type ProviderModel,
  type ProviderTest,
} from "@/lib/hooks/use-model-providers";

export default function ModelProvidersPage() {
  const providers = useModelProviders();
  const remove = useDeleteProvider();
  const [editing, setEditing] = useState<ModelProvider | "new" | null>(null);
  const [deleting, setDeleting] = useState<ModelProvider | null>(null);
  return (
    <div>
      <PageHeader title="Model Providers">
        {!editing && (
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" />
            Add Provider
          </Button>
        )}
      </PageHeader>
      <div className="space-y-6 p-6">
        <p className="text-sm text-neutral-500">
          Connect your own model service. Tested models become available when
          creating or editing an Agent.
        </p>
        {editing ? (
          <ProviderEditor
            key={editing === "new" ? "new" : editing.id}
            provider={editing === "new" ? undefined : editing}
            onClose={() => setEditing(null)}
          />
        ) : (
          <>
            {providers.isLoading && <p role="status">Loading providers…</p>}
            {providers.error && (
              <p role="alert" className="text-sm text-red-600">
                {providers.error.message}
              </p>
            )}
            {providers.data?.length === 0 && (
              <div className="rounded-2xl border border-dashed border-neutral-200 px-6 py-16 text-center">
                <Server className="mx-auto mb-3 h-8 w-8 text-neutral-400" />
                <p>No custom providers yet.</p>
                <p className="mt-2 text-sm text-neutral-500">
                  Choose a protocol, add your endpoint and API key, then test
                  the models you want to use.
                </p>
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              {providers.data?.map((provider) => (
                <section
                  key={provider.id}
                  className="rounded-2xl border border-neutral-200 p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-semibold">{provider.name}</h2>
                      <p className="mt-1 text-xs text-neutral-500">
                        {provider.api}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${provider.name}`}
                        onClick={() => setEditing(provider)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${provider.name}`}
                        onClick={() => setDeleting(provider)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="my-4 break-all text-sm text-neutral-500">
                    {provider.baseUrl}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {provider.models.map((model) => (
                      <span
                        key={model.id}
                        className="rounded-md bg-neutral-100 px-2 py-1 text-xs"
                      >
                        {model.name}
                      </span>
                    ))}
                  </div>
                  <p className="mt-4 flex items-center gap-1.5 text-xs text-neutral-500">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                    Tested {new Date(provider.testedAt).toLocaleString()}
                  </p>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete provider"
        description="Agents using this provider will need another model before their next Turn. Existing Session history is retained."
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting)
            remove.mutate(deleting.id, {
              onError: (error) => toast.error(error.message),
            });
        }}
      />
    </div>
  );
}

function ProviderEditor({
  provider,
  onClose,
}: {
  provider?: ModelProvider;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ProviderInput>(() =>
    provider
      ? {
          id: provider.id,
          name: provider.name,
          api: provider.api,
          baseUrl: provider.baseUrl,
          models: provider.models,
          apiKey: "",
        }
      : {
          name: "",
          api: "openai-completions",
          baseUrl: "",
          apiKey: "",
          models: [],
        },
  );
  const [search, setSearch] = useState("");
  const [manualId, setManualId] = useState("");
  const [proof, setProof] = useState<ProviderTest | null>(null);
  const protocols = useProviderProtocols();
  const discovery = useDiscoverProviderModels();
  const test = useTestProvider();
  const save = useSaveProvider();
  const busy = discovery.isPending || test.isPending || save.isPending;
  function change(patch: Partial<ProviderInput>) {
    const connectionChanged =
      "baseUrl" in patch || "apiKey" in patch || "api" in patch;
    if (connectionChanged) {
      discovery.reset();
      setSearch("");
    }
    setForm((current) => ({
      ...current,
      ...patch,
      ...(connectionChanged ? { models: [] } : {}),
    }));
    setProof(null);
    test.reset();
    save.reset();
  }
  function addModel(model: ProviderModel) {
    const existing = form.models.some((item) => item.id === model.id);
    if (form.models.length >= 10 && !existing) return;
    change({
      models: existing
        ? form.models.map((item) => (item.id === model.id ? model : item))
        : [...form.models, model],
    });
  }
  function editModel(id: string, patch: Partial<ProviderModel>) {
    change({
      models: form.models.map((model) =>
        model.id === id ? { ...model, ...patch } : model,
      ),
    });
  }
  const choices = (discovery.data?.data ?? []).filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  const canDiscover = form.baseUrl.trim() && (provider || form.apiKey?.trim());
  const valid =
    form.name.trim() &&
    form.baseUrl.trim() &&
    (provider || form.apiKey?.trim()) &&
    form.models.length > 0 &&
    form.models.every(
      (model) =>
        model.contextWindow >= 1024 &&
        model.maxTokens >= 128 &&
        model.maxTokens <= model.contextWindow,
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (proof)
          save.mutate(
            { ...form, verificationToken: proof.verificationToken },
            {
              onSuccess: () => {
                toast.success("Provider saved");
                onClose();
              },
            },
          );
      }}
      className="max-w-5xl rounded-2xl border border-neutral-200 bg-white p-6"
    >
      <h2 className="mb-6 text-lg font-semibold">
        {provider ? "Edit provider" : "Add provider"}
      </h2>
      <fieldset disabled={busy} className="space-y-6 disabled:opacity-70">
        <div className="grid gap-5 md:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium">
            Provider name
            <Input
              value={form.name}
              maxLength={200}
              required
              onChange={(e) => change({ name: e.target.value })}
              placeholder="My model gateway"
            />
          </label>
          <Select
            label="Protocol"
            id="provider-protocol"
            value={form.api}
            onChange={(e) => {
              change({ api: e.target.value, models: [] });
              setSearch("");
            }}
            disabled={busy}
          >
            {(
              protocols.data?.protocols ?? [
                { id: "openai-completions", name: "OpenAI Chat Completions" },
                { id: "openai-responses", name: "OpenAI Responses" },
                { id: "anthropic-messages", name: "Anthropic Messages" },
              ]
            ).map((protocol) => (
              <option key={protocol.id} value={protocol.id}>
                {protocol.name}
              </option>
            ))}
          </Select>
          <label className="space-y-1.5 text-sm font-medium">
            Base URL
            <Input
              type="url"
              value={form.baseUrl}
              required
              maxLength={2048}
              onChange={(e) => change({ baseUrl: e.target.value })}
              placeholder={
                form.api === "anthropic-messages"
                  ? "https://api.anthropic.com"
                  : "https://api.example.com/v1"
              }
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            API key
            <Input
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              required={!provider}
              maxLength={8192}
              onChange={(e) => change({ apiKey: e.target.value })}
              placeholder={
                provider
                  ? "Leave blank to keep the saved key"
                  : "Enter your provider API key"
              }
            />
          </label>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Models from endpoint</h3>
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={!canDiscover || busy}
                onClick={() => {
                  setProof(null);
                  discovery.reset();
                  discovery.mutate(
                    {
                      id: form.id,
                      api: form.api,
                      baseUrl: form.baseUrl,
                      apiKey: form.apiKey,
                    },
                    {
                      onSuccess: ({ data }) =>
                        setForm((current) => ({
                          ...current,
                          models: current.models.filter((model) =>
                            data.some((found) => found.id === model.id),
                          ),
                        })),
                    },
                  );
                }}
              >
                {discovery.isPending
                  ? "Fetching…"
                  : discovery.data
                    ? "Refresh models"
                    : "Fetch models"}
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              Fetch the model list using your endpoint and API key, then select
              up to 10 models to test.
            </p>
            {discovery.error && (
              <p role="alert" className="text-sm text-red-600">
                {discovery.error.message}
              </p>
            )}
            {discovery.isPending && (
              <p role="status" className="text-sm text-neutral-500">
                Fetching models from your endpoint…
              </p>
            )}
            {!discovery.data && !discovery.isPending && (
              <p className="rounded-lg bg-neutral-50 p-4 text-sm text-neutral-500">
                Enter a Base URL and API key, then click Fetch models. No model
                list is loaded until your endpoint responds.
              </p>
            )}
            {discovery.data && (
              <>
                <p role="status" className="text-xs text-neutral-500">
                  {discovery.data.data.length} model(s) returned by your
                  endpoint. Availability will be checked with a real model
                  request.
                </p>
                <Input
                  aria-label="Search endpoint models"
                  placeholder="Search returned models"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="max-h-60 overflow-y-auto rounded-lg border border-neutral-200">
                  {choices.slice(0, 100).map((model) => (
                    <label
                      key={model.id}
                      className="flex cursor-pointer items-start gap-2 border-b border-neutral-100 p-3 text-sm last:border-0"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={form.models.some(
                          (item) => item.id === model.id,
                        )}
                        disabled={
                          form.models.length >= 10 &&
                          !form.models.some((item) => item.id === model.id)
                        }
                        onChange={(e) =>
                          e.target.checked
                            ? addModel(model)
                            : change({
                                models: form.models.filter(
                                  (item) => item.id !== model.id,
                                ),
                              })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block break-all">{model.name}</span>
                        <span className="block break-all text-xs text-neutral-500">
                          {model.id}
                        </span>
                      </span>
                    </label>
                  ))}
                  {!choices.length && (
                    <p className="p-3 text-sm text-neutral-500">
                      {discovery.data.data.length
                        ? "No matching models."
                        : "The endpoint returned no models for this API key."}
                    </p>
                  )}
                </div>
                {choices.length > 100 && (
                  <p className="text-xs text-neutral-500">
                    Showing the first 100 matches. Search to narrow the list.
                  </p>
                )}
              </>
            )}
            <details className="text-xs text-neutral-500">
              <summary className="cursor-pointer">
                Enter a model ID manually
              </summary>
              <p className="my-3">
                For endpoints without a model-list API, enter the ID from your
                provider. It must still pass a real request test.
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label="Custom model ID"
                  placeholder="Custom model ID"
                  value={manualId}
                  maxLength={200}
                  onChange={(e) => setManualId(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 whitespace-nowrap"
                  disabled={
                    !manualId.trim() ||
                    form.models.length >= 10 ||
                    form.models.some((model) => model.id === manualId.trim())
                  }
                  onClick={() => {
                    addModel({
                      id: manualId.trim(),
                      name: manualId.trim(),
                      contextWindow: 32768,
                      maxTokens: 4096,
                      reasoning: false,
                      input: ["text"],
                    });
                    setManualId("");
                  }}
                >
                  Add model
                </Button>
              </div>
            </details>
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">
              Selected models ({form.models.length}/10)
            </h3>
            <p className="text-xs text-neutral-500">
              Check the context and output limits against your service. If the
              endpoint omits them, conservative defaults are used.
            </p>
            {form.models.length === 0 && (
              <p className="rounded-lg bg-neutral-50 p-5 text-sm text-neutral-500">
                Fetch and select a model or add a custom model ID to test the
                connection.
              </p>
            )}
            <div className="max-h-96 space-y-3 overflow-y-auto">
              {form.models.map((model) => (
                <div
                  key={model.id}
                  className="rounded-lg border border-neutral-200 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="break-all text-sm font-medium">
                      {model.id}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label={`Remove ${model.id}`}
                      onClick={() =>
                        change({
                          models: form.models.filter(
                            (item) => item.id !== model.id,
                          ),
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <details className="text-xs text-neutral-500">
                    <summary className="cursor-pointer">Model settings</summary>
                    <div className="mt-3 space-y-3">
                      <label className="block">
                        Display name
                        <Input
                          value={model.name}
                          required
                          maxLength={200}
                          onChange={(e) =>
                            editModel(model.id, { name: e.target.value })
                          }
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label>
                          Context tokens
                          <Input
                            type="number"
                            min={1024}
                            max={10000000}
                            value={model.contextWindow}
                            onChange={(e) =>
                              editModel(model.id, {
                                contextWindow: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          Max output tokens
                          <Input
                            type="number"
                            min={128}
                            max={model.contextWindow}
                            value={model.maxTokens}
                            onChange={(e) =>
                              editModel(model.id, {
                                maxTokens: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      </div>
                      <label className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={model.reasoning}
                          onChange={(e) =>
                            editModel(model.id, { reasoning: e.target.checked })
                          }
                        />
                        Supports reasoning
                      </label>
                      <label className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={model.input.includes("image")}
                          onChange={(e) =>
                            editModel(model.id, {
                              input: e.target.checked
                                ? ["text", "image"]
                                : ["text"],
                            })
                          }
                        />
                        Supports image input
                      </label>
                    </div>
                  </details>
                </div>
              ))}
            </div>
          </div>
        </div>
      </fieldset>
      <div className="mt-6 space-y-3 border-t border-neutral-100 pt-4">
        <p className="text-xs text-neutral-500">
          Testing sends a small real request through Pi to every selected model
          and may use provider credits. Changing the configuration requires a
          new test.
        </p>
        {test.isPending && (
          <p role="status" className="text-sm">
            Testing {form.models.length} model(s)… Up to 30 seconds per model.
          </p>
        )}
        {proof && (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-green-700"
          >
            <CheckCircle2 className="h-4 w-4" />
            All selected models responded successfully. Ready to save.
          </p>
        )}
        {(test.error || save.error) && (
          <p role="alert" className="text-sm text-red-600">
            {test.error?.message || save.error?.message}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!valid || busy}
            onClick={() => {
              setProof(null);
              test.mutate(form, { onSuccess: setProof });
            }}
          >
            {test.isPending ? "Testing…" : "Test selected models"}
          </Button>
          <Button type="submit" disabled={!proof || busy}>
            {save.isPending ? "Saving…" : "Save provider"}
          </Button>
        </div>
      </div>
    </form>
  );
}

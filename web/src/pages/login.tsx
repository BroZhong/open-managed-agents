import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { KeyRound } from "lucide-react";
import { useAuth } from "@/lib/auth";

const BASE_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export default function LoginPage() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(`${BASE_URL}/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        setError("Cannot reach server");
        return;
      }

      login(apiKey);
      navigate("/sessions");
    } catch {
      setError("Cannot reach server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <KeyRound className="h-8 w-8 text-[var(--color-fg)]" />
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">
            Open Managed Agents
          </h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Enter your API key to connect
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="api-key"
              className="mb-1 block text-sm font-medium text-[var(--color-fg)]"
            >
              API Key
            </label>
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              required
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-fg-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
            />
          </div>

          {error && (
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !apiKey}
            className="rounded-lg bg-[var(--color-fg)] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Connecting..." : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}

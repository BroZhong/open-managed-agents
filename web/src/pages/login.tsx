import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router";
import { BrandMark } from "@/components/brand-mark";
import { useAuth } from "@/lib/auth";
import { authLogin, AuthError } from "@/lib/auth-api";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { token } = await authLogin({ username, password });
      login(token);
      navigate("/");
    } catch (err) {
      if (err instanceof AuthError) {
        setError(err.message);
      } else {
        setError("Cannot reach server");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="mb-6 flex flex-col items-center gap-2">
          <BrandMark className="auth-brand" />
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">
            Open Managed Agents
          </h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Sign in to your account
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="username"
              className="mb-1 block text-sm font-medium text-[var(--color-fg)]"
            >
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-fg-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-[var(--color-fg)]"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-fg-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
            />
          </div>

          {error && (
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-fg-muted)]">
          Need an account?{" "}
          <Link
            to="/register"
            className="font-medium text-[var(--color-fg)] hover:underline"
          >
            Register
          </Link>
        </p>
      </div>
    </div>
  );
}

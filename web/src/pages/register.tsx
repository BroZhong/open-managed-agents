import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router";
import { BrandMark } from "@/components/brand-mark";
import { useAuth } from "@/lib/auth";
import { authRegister, AuthError } from "@/lib/auth-api";

const USERNAME_ERROR =
  "Username must be 3–32 characters and contain only English letters, numbers, underscores (_) or hyphens (-). Periods (.) and spaces are not allowed.";

export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setUsernameError(null);
    setInviteError(null);
    setError(null);

    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      setUsernameError(USERNAME_ERROR);
      return;
    }

    setLoading(true);

    try {
      const { token } = await authRegister({ username, password, inviteCode });
      login(token);
      navigate("/");
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === "invalid_invite_code") {
          setInviteError(err.message);
        } else if (err.code === "username_taken") {
          setUsernameError(err.message);
        } else {
          // validation_error, registration_closed, auth_unavailable, …
          setError(err.message);
        }
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
            Create your account
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
              onChange={(e) => {
                setUsername(e.target.value);
                setUsernameError(null);
              }}
              autoComplete="username"
              aria-invalid={!!usernameError}
              aria-describedby={usernameError ? "username-hint username-error" : "username-hint"}
              required
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-fg-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
            />
            <p id="username-hint" className="mt-1 text-sm text-[var(--color-fg-muted)]">
              3–32 characters: English letters, numbers, underscores (_) or hyphens (-).
              {" "}Example: user_123
            </p>
            {usernameError && (
              <p id="username-error" role="alert" className="mt-1 text-sm text-[var(--color-danger)]">
                {usernameError}
              </p>
            )}
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
              autoComplete="new-password"
              required
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-fg-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
            />
          </div>

          <div>
            <label
              htmlFor="invite-code"
              className="mb-1 block text-sm font-medium text-[var(--color-fg)]"
            >
              Invite code
            </label>
            <input
              id="invite-code"
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              required
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-fg-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
            />
            {inviteError && (
              <p className="mt-1 text-sm text-[var(--color-danger)]">
                {inviteError}
              </p>
            )}
          </div>

          {error && (
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password || !inviteCode}
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Creating account..." : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-fg-muted)]">
          Already have an account?{" "}
          <Link
            to="/login"
            className="font-medium text-[var(--color-fg)] hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

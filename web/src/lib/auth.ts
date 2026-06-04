import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { createElement } from "react";

const STORAGE_KEY = "oma_api_key";

interface AuthContextValue {
  isAuthenticated: boolean;
  token: string | null;
  login: (key: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );

  const isAuthenticated = token !== null;

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored !== token) {
      setToken(stored);
    }
  }, [token]);

  function login(key: string) {
    localStorage.setItem(STORAGE_KEY, key);
    setToken(key);
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    window.location.href = "/login";
  }

  return createElement(
    AuthContext.Provider,
    { value: { isAuthenticated, token, login, logout } },
    children,
  );
}

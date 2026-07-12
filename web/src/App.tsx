import { Routes, Route, Navigate } from "react-router";
import { useAuth } from "@/lib/auth";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import { AppLayout } from "@/components/app-layout";
import OverviewPage from "@/pages/overview";
import SessionDetailPage from "@/pages/session-detail";
import AgentsPage from "@/pages/agents";
import AgentDetailPage from "@/pages/agent-detail";
import SkillsPage from "@/pages/skills";
import ApiKeysPage from "@/pages/api-keys";
import McpPage from "@/pages/mcp";
import type { ReactNode } from "react";

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="/overview" element={<Navigate to="/" replace />} />
        {/* Sessions are only reached through an Agent — no global list route. */}
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/mcp" element={<McpPage />} />
        <Route path="/api-keys" element={<ApiKeysPage />} />
      </Route>
    </Routes>
  );
}

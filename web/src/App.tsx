import { Routes, Route, Navigate } from "react-router";
import { useAuth } from "@/lib/auth";
import LoginPage from "@/pages/login";
import { AppLayout } from "@/components/app-layout";
import SessionsPage from "@/pages/sessions";
import SessionDetailPage from "@/pages/session-detail";
import AgentsPage from "@/pages/agents";
import AgentDetailPage from "@/pages/agent-detail";
import ApiKeysPage from "@/pages/api-keys";
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
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/sessions" replace />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/api-keys" element={<ApiKeysPage />} />
      </Route>
    </Routes>
  );
}

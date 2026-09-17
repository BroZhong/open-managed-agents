import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { queryClient } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import SharedSessionPage from "@/pages/shared-session";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/share/:shareId" element={<SharedSessionPage />} />
        <Route path="*" element={
          <QueryClientProvider client={queryClient}>
            <AuthProvider><App /><Toaster position="bottom-right" /></AuthProvider>
          </QueryClientProvider>
        } />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

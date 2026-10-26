import type { EnvironmentBuildSummary, EnvironmentStatus } from "@/lib/hooks/use-environments";

/** How the console shows an Environment's build status (ADR-0024). */
export const ENVIRONMENT_STATUS: Record<EnvironmentStatus, { label: string; className: string }> = {
  pending: { label: "Pending build", className: "bg-amber-50 text-amber-700" },
  building: { label: "Building", className: "bg-blue-50 text-blue-700" },
  failed: { label: "Build failed", className: "bg-red-50 text-red-700" },
  ready: { label: "Ready", className: "bg-green-50 text-green-700" },
};

/** How the console shows one build's status. */
export const BUILD_STATUS: Record<EnvironmentBuildSummary["status"], { label: string; className: string }> = {
  pending: { label: "Queued", className: "bg-amber-50 text-amber-700" },
  running: { label: "Building", className: "bg-blue-50 text-blue-700" },
  succeeded: { label: "Succeeded", className: "bg-green-50 text-green-700" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700" },
  superseded: { label: "Superseded by a newer change", className: "bg-neutral-100 text-neutral-600" },
};

/** The words for an Environment's build status, wherever the console shows it. */
export const environmentStatusLabel = (status: EnvironmentStatus) => ENVIRONMENT_STATUS[status].label;

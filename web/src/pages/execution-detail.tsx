import { Link, useParams } from "react-router";
import { DelegationSources } from "@/components/delegation-sources";
import { ExecutionTraceView } from "@/components/execution-trace";

export default function ExecutionDetailPage() {
  const { id = "", executionId = "" } = useParams();
  return <section aria-label="Child Session execution detail" className="h-full overflow-auto">
    <header className="space-y-2 px-6 py-4"><h1 className="text-lg font-semibold">Child Session execution</h1><Link className="text-sm underline" to={`/sessions/${encodeURIComponent(id)}`}>Open complete child Session</Link><p className="font-mono text-xs">{id} · {executionId}</p></header>
    <DelegationSources sessionId={id} origin />
    <div className="mx-auto max-w-4xl p-6"><ExecutionTraceView key={`${id}:${executionId}`} sessionId={id} executionId={executionId} /></div>
  </section>;
}

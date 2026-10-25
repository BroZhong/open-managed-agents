import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { manifestItems, type ManifestItem } from "@/lib/environment-manifest";

const KINDS: Array<{ kind: ManifestItem["kind"]; label: string }> = [
  { kind: "binary", label: "Commands" },
  { kind: "pip", label: "Python" },
  { kind: "npm", label: "npm" },
  { kind: "dpkg", label: "System packages" },
];

/** What the Environment's image has preinstalled, searchable by name. */
export function EnvironmentManifest({ manifest }: { manifest: Record<string, unknown> | null }) {
  const items = useMemo(() => (manifest ? manifestItems(manifest) : []), [manifest]);
  const [kind, setKind] = useState<ManifestItem["kind"]>("binary");
  const [query, setQuery] = useState("");
  const shown = items.filter((item) => item.kind === kind && item.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section className="space-y-3" aria-label="Preinstalled">
      <h2 className="text-sm font-semibold">Preinstalled</h2>
      {!manifest ? <p className="text-sm text-neutral-500">Shown once an image has built.</p> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {KINDS.map((option) => (
              <button
                key={option.kind}
                type="button"
                aria-pressed={kind === option.kind}
                onClick={() => setKind(option.kind)}
                className={cn("rounded-md px-2 py-1 text-xs", kind === option.kind ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700")}
              >
                {option.label} {items.filter((item) => item.kind === option.kind).length}
              </button>
            ))}
            <Input aria-label="Search preinstalled software" placeholder="Search by name" value={query} onChange={(event) => setQuery(event.target.value)} className="ml-auto max-w-xs" />
          </div>
          {shown.length === 0 ? <p className="text-sm text-neutral-500">No matching entries.</p> : (
            <div className="max-h-[420px] overflow-auto rounded-xl border border-neutral-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-neutral-50 text-neutral-500">
                  <tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Version</th><th className="px-3 py-2 font-medium">Location</th></tr>
                </thead>
                <tbody>
                  {shown.map((item, index) => (
                    <tr key={`${item.where}:${item.name}:${index}`} className="border-t border-neutral-100">
                      <td className="px-3 py-1.5 font-mono">{item.name}</td>
                      <td className="break-all px-3 py-1.5 font-mono text-neutral-600">{item.version}</td>
                      <td className="break-all px-3 py-1.5 font-mono text-neutral-500">{item.where}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

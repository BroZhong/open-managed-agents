import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { manifestItems, type ManifestItem } from "@/lib/environment-manifest";

const KINDS: Array<{ kind: ManifestItem["kind"]; label: string }> = [
  { kind: "binary", label: "命令" },
  { kind: "pip", label: "Python" },
  { kind: "npm", label: "npm" },
  { kind: "dpkg", label: "系统包" },
];

/** What the Environment's image has preinstalled, searchable by name. */
export function EnvironmentManifest({ manifest }: { manifest: Record<string, unknown> | null }) {
  const items = useMemo(() => (manifest ? manifestItems(manifest) : []), [manifest]);
  const [kind, setKind] = useState<ManifestItem["kind"]>("binary");
  const [query, setQuery] = useState("");
  const shown = items.filter((item) => item.kind === kind && item.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section className="space-y-3" aria-label="预装清单">
      <h2 className="text-sm font-semibold">预装清单</h2>
      {!manifest ? <p className="text-sm text-neutral-500">镜像构建成功后显示。</p> : (
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
            <Input aria-label="搜索预装软件" placeholder="搜索名称" value={query} onChange={(event) => setQuery(event.target.value)} className="ml-auto max-w-xs" />
          </div>
          {shown.length === 0 ? <p className="text-sm text-neutral-500">没有匹配的条目。</p> : (
            <div className="max-h-[420px] overflow-auto rounded-xl border border-neutral-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-neutral-50 text-neutral-500">
                  <tr><th className="px-3 py-2 font-medium">名称</th><th className="px-3 py-2 font-medium">版本</th><th className="px-3 py-2 font-medium">位置</th></tr>
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

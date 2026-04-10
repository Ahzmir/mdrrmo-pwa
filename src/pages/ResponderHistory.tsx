import { useNavigate } from "react-router-dom";
import { ArrowLeft, Clock3 } from "lucide-react";
import { useIncidents } from "@/hooks/useIncidents";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";

export default function ResponderHistory() {
  const navigate = useNavigate();
  const incidents = useIncidents();
  const resolved = incidents.filter((incident) => incident.status === "resolved");

  return (
    <div className="mx-auto max-w-lg bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-4 pb-24">
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/45 bg-white/45 p-4 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <button onClick={() => navigate(-1)} className="p-1 text-muted-foreground">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-orange-600">Responder History</h1>
      </div>

      {resolved.length === 0 ? (
        <div className="rounded-xl border border-white/55 bg-white/60 p-6 text-center text-sm text-muted-foreground backdrop-blur-md">
          No resolved incidents yet.
        </div>
      ) : (
        <div className="space-y-3">
          {resolved.map((incident) => (
            <div key={incident.id} className="rounded-xl border border-white/55 bg-white/60 p-4 backdrop-blur-md">
              <div className="mb-2 flex items-center justify-between">
                <CategoryIcon category={incident.category} size={18} showLabel />
                <StatusBadge status={incident.status} />
              </div>
              <p className="text-sm text-foreground">{incident.description}</p>
              <p className="mt-1 text-xs text-muted-foreground">{incident.location}</p>
              <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock3 size={12} />
                {incident.createdAt.toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { SmsFallback } from "@/components/SmsFallback";
import { useReports } from "@/hooks/useReports";
import { StatusBadge } from "@/components/StatusBadge";
import { CategoryIcon } from "@/components/CategoryIcon";

export default function Home() {
  const navigate = useNavigate();
  const reports = useReports();
  const recent = reports.slice(0, 3);

  return (
    <div className="flex flex-col gap-6 pb-24 px-4 pt-6 max-w-lg mx-auto">
      {/* Header */}
      <div className="text-center">
        <div className="inline-flex items-center gap-2 bg-emergency-light text-emergency rounded-full px-3 py-1 text-xs font-semibold mb-3">
          <AlertTriangle size={14} />
          Emergency Response
        </div>
        <h1 className="text-2xl font-black tracking-tight text-foreground">
          Community Safety
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Report emergencies quickly and track response
        </p>
      </div>

      {/* Big CTA */}
      <button
        onClick={() => navigate("/report")}
        className="emergency-pulse w-full bg-emergency text-emergency-foreground rounded-2xl py-5 px-6 text-lg font-bold shadow-lg active:scale-[0.98] transition-transform flex items-center justify-center gap-3"
      >
        <AlertTriangle size={28} />
        REPORT INCIDENT
      </button>

      {/* SMS Fallback */}
      <SmsFallback />

      {/* Recent Reports */}
      {recent.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">
              Recent Reports
            </h2>
            <button
              onClick={() => navigate("/my-reports")}
              className="text-xs text-emergency font-medium flex items-center gap-0.5"
            >
              View All <ChevronRight size={14} />
            </button>
          </div>
          <div className="space-y-2">
            {recent.map((r) => (
              <div
                key={r.id}
                className="bg-card rounded-xl p-3 border flex items-center gap-3"
              >
                {r.photoUrl ? (
                  <img
                    src={r.photoUrl}
                    alt="Reported incident"
                    loading="lazy"
                    className="w-12 h-12 rounded-md object-cover border shrink-0"
                  />
                ) : (
                  <CategoryIcon category={r.category} size={20} />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate text-foreground">
                    {r.description || r.category}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {r.location}
                  </p>
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

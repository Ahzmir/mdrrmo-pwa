import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useReports } from "@/hooks/useReports";
import { StatusBadge } from "@/components/StatusBadge";
import { CategoryIcon } from "@/components/CategoryIcon";

export default function Home() {
  const navigate = useNavigate();
  const reports = useReports();
  const recent = reports.slice(0, 3);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-6 pb-24">
      {/* Header */}
      <div className="text-center">
        <img
          src="/assets/banisilan.png"
          alt="Municipality of Banisilan Seal"
          className="mx-auto mb-3 h-20 w-20 object-contain"
        />
        <div className="mb-2 inline-flex items-center rounded-full border border-orange-300 bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-600">
          MDRRMO Banisilan
        </div>
        <h1 className="text-3xl font-black tracking-tight text-orange-600">
          Community Safety
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Report emergencies quickly and track response
        </p>
      </div>

      {/* Big CTA */}
      <button
        onClick={() => navigate("/report")}
        className="orange-red-pulse mx-auto flex h-52 w-52 flex-col items-center justify-center gap-2 rounded-full border border-orange-200 bg-orange-600 text-center text-lg font-bold text-white shadow-[0_24px_50px_-28px_rgba(234,88,12,0.7)] transition-transform active:scale-[0.98]"
      >
        <AlertTriangle size={34} />
        <span className="leading-tight">REPORT INCIDENT</span>
      </button>

      {/* Recent Reports */}
      {recent.length > 0 && (
        <div className="rounded-2xl border border-white/45 bg-white/45 p-4 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">
              Recent Reports
            </h2>
            <button
              onClick={() => navigate("/my-reports")}
              className="flex items-center gap-0.5 text-xs font-medium text-orange-600"
            >
              View All <ChevronRight size={14} />
            </button>
          </div>
          <div className="space-y-2">
            {recent.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-xl border border-white/50 bg-white/65 p-3 backdrop-blur-md"
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

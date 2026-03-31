import { ReportStatus } from "@/types/incident";
import { cn } from "@/lib/utils";

const statusConfig: Record<ReportStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-warning-light text-warning-foreground" },
  assigned: { label: "Assigned", className: "bg-info-light text-info" },
  en_route: { label: "En Route", className: "bg-info-light text-info" },
  on_scene: { label: "On Scene", className: "bg-emergency-light text-emergency" },
  resolved: { label: "Resolved", className: "bg-success-light text-success" },
};

export function StatusBadge({ status }: { status: ReportStatus }) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold tracking-wide uppercase",
        config.className
      )}
    >
      {config.label}
    </span>
  );
}

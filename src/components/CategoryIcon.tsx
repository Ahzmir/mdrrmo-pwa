import { Flame, HeartPulse, ShieldAlert, CloudLightning } from "lucide-react";
import { IncidentCategory } from "@/types/incident";
import { cn } from "@/lib/utils";

const config: Record<IncidentCategory, { icon: typeof Flame; color: string; label: string }> = {
  fire: { icon: Flame, color: "text-fire", label: "Fire" },
  medical: { icon: HeartPulse, color: "text-medical", label: "Medical" },
  crime: { icon: ShieldAlert, color: "text-crime", label: "Crime" },
  disaster: { icon: CloudLightning, color: "text-disaster", label: "Disaster" },
};

export function CategoryIcon({
  category,
  size = 24,
  showLabel = false,
}: {
  category: IncidentCategory;
  size?: number;
  showLabel?: boolean;
}) {
  const { icon: Icon, color, label } = config[category];
  return (
    <span className={cn("inline-flex items-center gap-1.5", color)}>
      <Icon size={size} />
      {showLabel && <span className="text-sm font-medium">{label}</span>}
    </span>
  );
}

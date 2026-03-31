import { MessageSquare, WifiOff } from "lucide-react";

export function SmsFallback() {
  return (
    <div className="rounded-xl border-2 border-dashed border-warning bg-warning-light p-4">
      <div className="flex items-center gap-2 mb-3">
        <WifiOff className="text-warning" size={20} />
        <h3 className="font-bold text-sm text-warning-foreground">No Internet? Report via SMS</h3>
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Text your report using this format:
        </p>
        <div className="bg-card rounded-lg p-3 font-mono text-xs leading-relaxed border">
          <span className="text-emergency font-bold">FIRE</span>{" "}
          <span className="text-muted-foreground">&lt;location&gt;</span>{" "}
          <span className="text-muted-foreground">&lt;description&gt;</span>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <MessageSquare size={14} className="text-muted-foreground" />
          <p className="text-xs font-semibold text-foreground">
            Send to: <span className="text-emergency">911-TEXT</span>
          </p>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Categories: FIRE, MEDICAL, CRIME, DISASTER
        </p>
      </div>
    </div>
  );
}

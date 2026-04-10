import { LayoutDashboard, History, Activity, Settings } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

const tabs = [
  { path: "/responder", icon: LayoutDashboard, label: "Dashboard" },
  { path: "/responder/history", icon: History, label: "History" },
  { path: "/responder/status", icon: Activity, label: "Status" },
];

export function ResponderNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const settingsActive = pathname === "/responder/settings";

  return (
    <nav className="fixed inset-x-0 bottom-3 z-50 px-3 safe-area-pb">
      <div className="mx-auto flex h-16 max-w-lg items-center justify-around rounded-2xl border border-white/45 bg-white/70 shadow-[0_20px_45px_-24px_rgba(15,23,42,0.45)] backdrop-blur-xl">
        {tabs.map(({ path, icon: Icon, label }) => {
          const active = pathname === path;
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={cn(
                "flex min-w-[64px] flex-col items-center gap-0.5 rounded-lg px-3 py-1 transition-colors",
                active ? "text-orange-600" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon size={20} strokeWidth={active ? 2.5 : 2} />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          );
        })}
        <button
          onClick={() => navigate("/responder/settings")}
          className={cn(
            "flex min-w-[64px] flex-col items-center gap-0.5 rounded-lg px-3 py-1 transition-colors",
            settingsActive ? "text-orange-600" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Settings size={20} strokeWidth={settingsActive ? 2.5 : 2} />
          <span className="text-[10px] font-medium">Settings</span>
        </button>
      </div>
    </nav>
  );
}

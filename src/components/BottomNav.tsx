import { Home, PlusCircle, ClipboardList, LogOut } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";

const tabs = [
  { path: "/", icon: Home, label: "Home" },
  { path: "/report", icon: PlusCircle, label: "Report" },
  { path: "/my-reports", icon: ClipboardList, label: "My Reports" },
];

export function BottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <nav className="fixed bottom-0 inset-x-0 z-50 bg-card border-t border-border safe-area-pb">
      <div className="flex items-center justify-around h-16 max-w-lg mx-auto">
        {tabs.map(({ path, icon: Icon, label }) => {
          const active = pathname === path;
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={cn(
                "flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors min-w-[64px]",
                active
                  ? "text-emergency"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.5 : 2} />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          );
        })}
        <button
          onClick={handleLogout}
          className="flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors min-w-[64px] text-muted-foreground hover:text-foreground"
        >
          <LogOut size={22} strokeWidth={2} />
          <span className="text-[10px] font-medium">Logout</span>
        </button>
      </div>
    </nav>
  );
}

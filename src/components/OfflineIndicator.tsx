import { WifiOff } from "lucide-react";
import { useState, useEffect } from "react";

export function OfflineIndicator() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[100] bg-warning text-warning-foreground text-center py-1.5 text-xs font-semibold flex items-center justify-center gap-1.5">
      <WifiOff size={14} />
      You are offline
    </div>
  );
}

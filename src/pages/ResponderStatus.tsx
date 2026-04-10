import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Activity } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { db } from "@/lib/firebase";
import { collection, doc, limit, onSnapshot, query, where } from "firebase/firestore";
import { updateResponderDutyStatus } from "@/stores/incidentStore";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type ResponderDutyStatus = "Available" | "Deployed" | "Off-Duty";

export default function ResponderStatus() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const responderUid = user?.role === "responder" ? user.id : null;
  const [responderDutyStatus, setResponderDutyStatus] = useState<ResponderDutyStatus | null>(null);
  const [isUpdatingDutyStatus, setIsUpdatingDutyStatus] = useState(false);

  useEffect(() => {
    if (!responderUid) {
      setResponderDutyStatus(null);
      return;
    }

    const directResponderRef = doc(db, "responders", responderUid);
    const byUidQuery = query(collection(db, "responders"), where("uid", "==", responderUid), limit(1));
    let fallbackUnsubscribe: (() => void) | null = null;

    const applyStatus = (data: Record<string, unknown>) => {
      const status = data.status;
      if (status === "Available" || status === "Deployed" || status === "Off-Duty") {
        setResponderDutyStatus(status);
      }
    };

    const subscribeFallback = () => {
      if (fallbackUnsubscribe) return;
      fallbackUnsubscribe = onSnapshot(byUidQuery, (snapshot) => {
        if (snapshot.empty) return;
        applyStatus(snapshot.docs[0].data() as Record<string, unknown>);
      });
    };

    const unsubscribe = onSnapshot(
      directResponderRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          subscribeFallback();
          return;
        }
        applyStatus(snapshot.data() as Record<string, unknown>);
      },
      () => {
        subscribeFallback();
      }
    );

    return () => {
      try {
        unsubscribe();
      } catch {
        // noop
      }
      if (fallbackUnsubscribe) {
        try {
          fallbackUnsubscribe();
        } catch {
          // noop
        }
      }
    };
  }, [responderUid]);

  async function handleSetDutyStatus(nextStatus: "Available" | "Off-Duty") {
    if (responderDutyStatus === nextStatus) {
      return;
    }

    setIsUpdatingDutyStatus(true);
    try {
      await updateResponderDutyStatus(nextStatus);
      setResponderDutyStatus(nextStatus);
      toast.success(`Responder status set to ${nextStatus}.`);
    } catch (error) {
      const message =
        (error as { code?: string }).code === "permission-denied"
          ? "Permission denied while updating status. Please refresh and try again."
          : (error as Error).message || "Unable to update responder status.";
      toast.error(message);
    } finally {
      setIsUpdatingDutyStatus(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-4 pb-24">
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/45 bg-white/45 p-4 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <button onClick={() => navigate(-1)} className="p-1 text-muted-foreground">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-orange-600">Responder Status</h1>
      </div>

      <div className="rounded-xl border border-white/55 bg-white/60 p-4 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-orange-600" />
          <p className="text-sm font-semibold text-foreground">
            Duty Status: <span className="font-bold">{responderDutyStatus || "Unknown"}</span>
          </p>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => void handleSetDutyStatus("Available")}
            disabled={isUpdatingDutyStatus || responderDutyStatus === "Deployed"}
            className={cn(
              "rounded-lg px-3 py-2 text-xs font-semibold",
              responderDutyStatus === "Available" ? "bg-success text-success-foreground" : "bg-white/70 text-foreground",
              (isUpdatingDutyStatus || responderDutyStatus === "Deployed") && "opacity-60"
            )}
          >
            Available
          </button>
          <button
            onClick={() => void handleSetDutyStatus("Off-Duty")}
            disabled={isUpdatingDutyStatus || responderDutyStatus === "Deployed"}
            className={cn(
              "rounded-lg px-3 py-2 text-xs font-semibold",
              responderDutyStatus === "Off-Duty" ? "bg-muted text-foreground" : "bg-white/70 text-foreground",
              (isUpdatingDutyStatus || responderDutyStatus === "Deployed") && "opacity-60"
            )}
          >
            Off-Duty
          </button>
        </div>

        {responderDutyStatus === "Deployed" && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Status switches are disabled while assigned to an active incident.
          </p>
        )}
      </div>
    </div>
  );
}

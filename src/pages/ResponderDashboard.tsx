import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useIncidents } from "@/hooks/useIncidents";
import { acceptIncident, rejectIncident, updateIncidentStatus, updateResponderDutyStatus } from "@/stores/incidentStore";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { SmsFallback } from "@/components/SmsFallback";
import { auth, db } from "@/lib/firebase";
import { Timestamp, collection, doc, limit, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import {
  LogOut,
  Navigation,
  CheckCircle2,
  X,
  Truck,
  MapPin,
  Clock,
  AlertTriangle,
  LocateFixed,
} from "lucide-react";
import { IncidentReport, ReportStatus } from "@/types/incident";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type ResponderDutyStatus = "Available" | "Deployed" | "Off-Duty";

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function mapGeolocationError(error: GeolocationPositionError | { message?: string; code?: number }) {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Location requires HTTPS on Safari. Open the app using an https:// URL (not IP/localhost).";
  }

  const message = (error.message || "").toLowerCase();
  if (message.includes("origin does not have permission") || message.includes("secure")) {
    return "Safari blocked location for this origin. Use HTTPS and enable iPhone Settings > Privacy & Security > Location Services > Safari Websites > While Using the App.";
  }

  if (error.code === 1) {
    return "Location permission denied. Enable Safari location access in iPhone Settings and reload.";
  }

  if (error.code === 3) {
    return "Location request timed out. Move to an open area and try again.";
  }

  if (error.code === 2) {
    return "Unable to determine your location. Check GPS/network and retry.";
  }

  return error.message || "Unable to get device location.";
}

async function patchResponderLocationViaRest(
  uid: string,
  latitude: number,
  longitude: number,
  accuracy: number | null
) {
  if (!auth.currentUser) {
    throw new Error("No authenticated responder session.");
  }

  const token = await auth.currentUser.getIdToken();
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  if (!projectId) {
    throw new Error("Missing VITE_FIREBASE_PROJECT_ID for REST fallback.");
  }

  const nowIso = new Date().toISOString();
  const authUid = auth.currentUser.uid;
  const targetUid = authUid || uid;
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/responderLiveLocations/${targetUid}` +
    `?updateMask.fieldPaths=uid` +
    `&updateMask.fieldPaths=liveLocation` +
    `&updateMask.fieldPaths=liveLocationUpdatedAt` +
    `&updateMask.fieldPaths=updatedAt`;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          uid: { stringValue: targetUid },
          liveLocation: {
            mapValue: {
              fields: {
                latitude: { doubleValue: latitude },
                longitude: { doubleValue: longitude },
                lat: { doubleValue: latitude },
                lng: { doubleValue: longitude },
                accuracy:
                  accuracy === null
                    ? { nullValue: null }
                    : { doubleValue: accuracy },
              },
            },
          },
          liveLocationUpdatedAt: { timestampValue: nowIso },
          updatedAt: { timestampValue: nowIso },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`REST write failed (${response.status}): ${errorText}`);
    }
  } finally {
    window.clearTimeout(timeoutId);
  }
}

const statusActions: { status: ReportStatus; icon: typeof Truck; label: string; color: string }[] = [
  { status: "en_route", icon: Truck, label: "En Route", color: "bg-info text-info-foreground" },
  { status: "on_scene", icon: MapPin, label: "On Scene", color: "bg-warning text-warning-foreground" },
  { status: "resolved", icon: CheckCircle2, label: "Resolved", color: "bg-success text-success-foreground" },
];

function IncidentCard({
  incident,
  onViewDetails,
  onAccept,
  onDecline,
  onUpdateStatus,
}: {
  incident: IncidentReport;
  onViewDetails?: () => void;
  onAccept: (incidentId: string) => Promise<void>;
  onDecline: (incidentId: string) => Promise<void>;
  onUpdateStatus: (incidentId: string, status: ReportStatus) => Promise<void>;
}) {
  const canViewDetails = !!incident.coordinates;

  function runAction(action: () => void | Promise<void>) {
    return (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      void Promise.resolve(action()).catch((error) => {
        toast.error((error as Error).message || "Unable to update incident.");
      });
    };
  }

  const awaitingDecision = incident.responderAssignmentStatus === "assigned";
  const canProgressStatus = incident.responderAssignmentStatus === "accepted";

  return (
    <div
      onClick={canViewDetails ? onViewDetails : undefined}
      className={cn(
        "bg-card rounded-xl border p-4 space-y-3 transition-all",
        canViewDetails && "cursor-pointer hover:border-info/40 hover:shadow-sm",
        awaitingDecision && "border-emergency/40 ring-2 ring-emergency/10"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CategoryIcon category={incident.category} size={20} showLabel />
          {awaitingDecision && (
            <span className="bg-emergency text-emergency-foreground text-[10px] font-bold px-2 py-0.5 rounded-full uppercase">
              Assignment Request
            </span>
          )}
        </div>
        <StatusBadge status={incident.status} />
      </div>

      {/* Description */}
      <p className="text-sm text-foreground leading-relaxed">{incident.description}</p>

      {/* Location */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <MapPin size={14} className="mt-0.5 shrink-0" />
        <span>{incident.location}</span>
      </div>

      {/* Time */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Clock size={12} />
        <span>
          {incident.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          {" · "}
          {Math.round((Date.now() - incident.createdAt.getTime()) / 60000)} min ago
        </span>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1">
        {/* Navigate */}
        {incident.coordinates && onViewDetails && (
          <button
            onClick={runAction(onViewDetails)}
            className="flex items-center gap-1.5 bg-info text-info-foreground rounded-xl px-3 py-2 text-xs font-semibold"
          >
            <Navigation size={14} />
            Navigate (Geoapify)
          </button>
        )}

        {canViewDetails && onViewDetails && (
          <button
            onClick={runAction(onViewDetails)}
            className="flex items-center gap-1.5 bg-secondary text-foreground rounded-xl px-3 py-2 text-xs font-semibold"
          >
            <MapPin size={14} />
            View Details
          </button>
        )}

        {/* Status updates */}
        {incident.status !== "resolved" &&
          canProgressStatus &&
          statusActions
            .filter((a) => {
              if (incident.status === "assigned") return a.status === "en_route";
              if (incident.status === "en_route") return a.status === "on_scene";
              if (incident.status === "on_scene") return a.status === "resolved";
              return false;
            })
            .map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.status}
                  onClick={runAction(() => onUpdateStatus(incident.id, a.status))}
                  className={cn(
                    "flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold",
                    a.color
                  )}
                >
                  <Icon size={14} />
                  {a.label}
                </button>
              );
            })}

        {awaitingDecision && (
          <button
            onClick={runAction(() => onAccept(incident.id))}
            className="flex items-center gap-1.5 bg-info text-info-foreground rounded-xl px-3 py-2 text-xs font-semibold"
          >
            <CheckCircle2 size={14} />
            Yes, Accept
          </button>
        )}

        {/* Reject assignment request */}
        {awaitingDecision && (
          <button
            onClick={runAction(() => onDecline(incident.id))}
            className="flex items-center gap-1.5 bg-muted text-muted-foreground rounded-xl px-3 py-2 text-xs font-semibold"
          >
            <X size={14} />
            No, Reject
          </button>
        )}
      </div>
    </div>
  );
}

export default function ResponderDashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const incidents = useIncidents();
  const active = incidents.filter((i) => i.status !== "resolved");
  const resolved = incidents.filter((i) => i.status === "resolved");
  const responderUid = user?.role === "responder" ? user.id : null;
  const [lastLiveUpdate, setLastLiveUpdate] = useState<Date | null>(null);
  const [hasLiveCoordinates, setHasLiveCoordinates] = useState(false);
  const [locationDocLoading, setLocationDocLoading] = useState(true);
  const [locationStatusError, setLocationStatusError] = useState<string | null>(null);
  const [locationSyncError, setLocationSyncError] = useState<string | null>(null);
  const [syncingLocation, setSyncingLocation] = useState(false);
  const [syncLogLines, setSyncLogLines] = useState<string[]>([]);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [responderDutyStatus, setResponderDutyStatus] = useState<ResponderDutyStatus | null>(null);
  const [isUpdatingDutyStatus, setIsUpdatingDutyStatus] = useState(false);
  const syncInFlightRef = useRef(false);

  const appendSyncLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const line = `[${timestamp}] ${message}`;
    setSyncLogLines((current) => {
      const next = [...current, line];
      return next.slice(-14);
    });
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTick(Date.now());
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!responderUid) {
      setResponderDutyStatus(null);
      return;
    }

    const directResponderRef = doc(db, "responders", responderUid);
    const byUidQuery = query(collection(db, "responders"), where("uid", "==", responderUid), limit(1));
    let fallbackUnsubscribe: (() => void) | null = null;

    const applySnapshot = (snapshot: { exists: () => boolean; data: () => Record<string, unknown> }) => {
      if (!snapshot.exists()) {
        return;
      }

      const data = snapshot.data();
      const status = data.status;
      if (status === "Available" || status === "Deployed" || status === "Off-Duty") {
        setResponderDutyStatus(status);
      }
    };

    const subscribeFallback = () => {
      if (fallbackUnsubscribe) {
        return;
      }

      fallbackUnsubscribe = onSnapshot(byUidQuery, (querySnapshot) => {
        if (querySnapshot.empty) {
          return;
        }

        const first = querySnapshot.docs[0];
        const data = first.data() as Record<string, unknown>;
        const status = data.status;
        if (status === "Available" || status === "Deployed" || status === "Off-Duty") {
          setResponderDutyStatus(status);
        }
      });
    };

    const unsubscribe = onSnapshot(
      directResponderRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          subscribeFallback();
          return;
        }

        applySnapshot(snapshot as { exists: () => boolean; data: () => Record<string, unknown> });
      },
      () => {
        subscribeFallback();
      }
    );

    return () => {
      try {
        unsubscribe();
      } catch {
        // Guard against Firestore SDK assertion during teardown.
      }
      if (fallbackUnsubscribe) {
        try {
          fallbackUnsubscribe();
        } catch {
          // Guard against Firestore SDK assertion during teardown.
        }
      }
    };
  }, [responderUid]);

  useEffect(() => {
    if (!responderUid) {
      setLastLiveUpdate(null);
      setHasLiveCoordinates(false);
      setLastSuccessfulSyncAt(null);
      setLocationStatusError(null);
      setLocationSyncError(null);
      setLocationDocLoading(false);
      setSyncLogLines([]);
      return;
    }

    setLocationDocLoading(true);
    setLocationStatusError(null);

    const liveRef = doc(db, "responderLiveLocations", responderUid);
    const legacyRef = doc(db, "responders", responderUid);
    let fallbackUnsubscribe: (() => void) | null = null;

    const subscribeLegacyResponderDoc = () => {
      if (fallbackUnsubscribe) {
        return;
      }

      appendSyncLog("Falling back to legacy responder doc listener.");
      fallbackUnsubscribe = onSnapshot(
        legacyRef,
        (snapshot) => {
          if (!snapshot.exists()) {
            const hasRecentSuccessfulSync =
              lastSuccessfulSyncAt !== null && nowTick - lastSuccessfulSyncAt.getTime() <= 60000;

            if (!hasRecentSuccessfulSync) {
              setLastLiveUpdate(null);
              setHasLiveCoordinates(false);
            }
            setLocationStatusError("Responder profile not found.");
            setLocationDocLoading(false);
            return;
          }

          const data = snapshot.data() as Record<string, unknown>;
          const liveLocation = data.liveLocation as
            | { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown }
            | undefined;

          const latitude = liveLocation?.latitude ?? liveLocation?.lat;
          const longitude = liveLocation?.longitude ?? liveLocation?.lng;

          const hasCoords =
            (typeof latitude === "number" || (typeof latitude === "string" && latitude.trim() !== "")) &&
            (typeof longitude === "number" || (typeof longitude === "string" && longitude.trim() !== ""));

          const nextLastUpdate = toDate(data.liveLocationUpdatedAt);
          const hasRecentSuccessfulSync =
            lastSuccessfulSyncAt !== null && nowTick - lastSuccessfulSyncAt.getTime() <= 60000;

          if (hasCoords || !hasRecentSuccessfulSync) {
            setHasLiveCoordinates(hasCoords);
            setLastLiveUpdate(nextLastUpdate);
          }

          if (hasCoords && nextLastUpdate) {
            setLastSuccessfulSyncAt(nextLastUpdate);
          }
          setLocationStatusError(null);
          setLocationDocLoading(false);
        },
        (error) => {
          const code = (error as { code?: string }).code || "unknown";
          appendSyncLog(`Legacy listener error (${code}): ${error.message || "no message"}`);
          setLastLiveUpdate(null);
          setHasLiveCoordinates(false);
          setLocationStatusError(error.message || "Unable to read responder location status.");
          setLocationDocLoading(false);
        }
      );
    };

    const unsubscribe = onSnapshot(
      liveRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          subscribeLegacyResponderDoc();
          return;
        }

        const data = snapshot.data() as Record<string, unknown>;
        const liveLocation = data.liveLocation as
          | { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown }
          | undefined;

        const latitude = liveLocation?.latitude ?? liveLocation?.lat;
        const longitude = liveLocation?.longitude ?? liveLocation?.lng;

        const hasCoords =
          (typeof latitude === "number" || (typeof latitude === "string" && latitude.trim() !== "")) &&
          (typeof longitude === "number" || (typeof longitude === "string" && longitude.trim() !== ""));

        const nextLastUpdate = toDate(data.liveLocationUpdatedAt);
        const hasRecentSuccessfulSync =
          lastSuccessfulSyncAt !== null && nowTick - lastSuccessfulSyncAt.getTime() <= 60000;

        if (hasCoords || !hasRecentSuccessfulSync) {
          setHasLiveCoordinates(hasCoords);
          setLastLiveUpdate(nextLastUpdate);
        }

        if (hasCoords && nextLastUpdate) {
          setLastSuccessfulSyncAt(nextLastUpdate);
        }
        setLocationStatusError(null);
        setLocationDocLoading(false);
      },
      (error) => {
        const code = (error as { code?: string }).code;
        if (code === "permission-denied") {
          appendSyncLog("Live-location listener permission denied. Switching to legacy listener.");
          subscribeLegacyResponderDoc();
          return;
        }

        appendSyncLog(`Live-location listener error (${code || "unknown"}): ${error.message || "no message"}`);
        setLastLiveUpdate(null);
        setHasLiveCoordinates(false);
        setLocationStatusError(error.message || "Unable to read responder location status.");
        setLocationDocLoading(false);
      }
    );

    return () => {
      try {
        unsubscribe();
      } catch {
        // Guard against Firestore SDK assertion during teardown.
      }
      if (fallbackUnsubscribe) {
        try {
          fallbackUnsubscribe();
        } catch {
          // Guard against Firestore SDK assertion during teardown.
        }
      }
    };
  }, [appendSyncLog, responderUid]);

  const syncResponderLocation = useCallback(async () => {
    if (!responderUid) {
      appendSyncLog("Sync skipped: missing responder UID.");
      return;
    }

    if (syncInFlightRef.current) {
      appendSyncLog("Sync skipped: previous sync still in-flight.");
      return;
    }

    if (!navigator.geolocation) {
      setLocationSyncError("Geolocation is not available on this device.");
      appendSyncLog("Sync failed: geolocation unsupported by browser/device.");
      return;
    }

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setLocationSyncError("Location requires HTTPS on Safari. Open the app using an https:// URL.");
      appendSyncLog("Sync failed: insecure origin (Safari requires HTTPS for location).");
      return;
    }

    if (!navigator.onLine) {
      setLocationSyncError("Device appears offline. Connect to the internet and try again.");
      appendSyncLog("Sync failed: browser reports offline.");
      return;
    }

    syncInFlightRef.current = true;
    setSyncingLocation(true);
    appendSyncLog("Sync started.");

    try {
      await new Promise<void>((resolve) => {
        let finished = false;
        let stage: "geolocation" | "firestore" = "geolocation";
        const finish = () => {
          if (finished) {
            return;
          }

          finished = true;
          resolve();
        };

        const guardTimeoutId = window.setTimeout(() => {
          setLocationSyncError("Location request took too long. Try Sync location now again.");
          appendSyncLog(`Sync timeout at stage: ${stage}.`);
          finish();
        }, 22000);

        appendSyncLog("Requesting geolocation...");
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            try {
              stage = "firestore";
              appendSyncLog(
                `Geolocation success lat=${position.coords.latitude.toFixed(6)}, lng=${position.coords.longitude.toFixed(6)}.`
              );
              const livePayload = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy ?? null,
              };
              const authUid = auth.currentUser?.uid || "(none)";
              const projectId = (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined) || "(missing)";
              if (authUid !== responderUid) {
                appendSyncLog(`UID mismatch auth=${authUid} responder=${responderUid}.`);
              }
              appendSyncLog(`Firebase target project=${projectId}, authUid=${authUid}.`);

              // Primary write path: existing responders document.
              const legacyResponderRef = doc(db, "responders", responderUid);
              appendSyncLog("Writing liveLocation to responders/{uid}...");
              let sdkWriteCompleted = false;
              const sdkWrite = updateDoc(legacyResponderRef, {
                sessionActive: true,
                sessionLastSeenAt: serverTimestamp(),
                liveLocation: livePayload,
                liveLocationUpdatedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });

              await Promise.race([
                sdkWrite.then(() => {
                  sdkWriteCompleted = true;
                }),
                new Promise<void>((resolve) => window.setTimeout(resolve, 6000)),
              ]);

              if (!sdkWriteCompleted) {
                appendSyncLog("SDK write stalled; using REST fallback write...");
                await patchResponderLocationViaRest(
                  responderUid,
                  livePayload.latitude,
                  livePayload.longitude,
                  livePayload.accuracy
                );
                appendSyncLog("REST fallback write succeeded.");
              } else {
                appendSyncLog("Legacy responder write succeeded.");
              }

              // Best-effort mirror to dedicated collection when rules are deployed.
              const responderLiveRef = doc(db, "responderLiveLocations", responderUid);
              appendSyncLog("Mirroring to responderLiveLocations/{uid}...");
              void Promise.race([
                setDoc(
                  responderLiveRef,
                  {
                    uid: responderUid,
                    liveLocation: livePayload,
                    liveLocationUpdatedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                  },
                  { merge: true }
                ),
                new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
              ])
                .then(() => {
                  appendSyncLog("Mirror write dispatched.");
                })
                .catch((error) => {
                  const code = (error as { code?: string }).code || "unknown";
                  appendSyncLog(`Mirror write failed (${code}) but live location sync already succeeded.`);
                });

              // Reflect successful sync immediately even if listeners are delayed.
              setHasLiveCoordinates(true);
              const successfulSyncAt = new Date();
              setLastLiveUpdate(successfulSyncAt);
              setLastSuccessfulSyncAt(successfulSyncAt);
              setLocationStatusError(null);
              setLocationSyncError(null);
              appendSyncLog("Sync finished successfully.");
            } catch (error) {
              const code = (error as { code?: string }).code;
              if (code) {
                setLocationSyncError(`Unable to sync live location (${code}).`);
                appendSyncLog(`Sync failed (${code}).`);
              } else {
                setLocationSyncError((error as Error).message || "Unable to sync live location.");
                appendSyncLog(`Sync failed: ${(error as Error).message || "unknown error"}`);
              }
            } finally {
              window.clearTimeout(guardTimeoutId);
              finish();
            }
          },
          (error) => {
            window.clearTimeout(guardTimeoutId);
            if (error.code === error.PERMISSION_DENIED) {
              setLocationSyncError(mapGeolocationError(error));
              appendSyncLog("Geolocation denied by user/browser.");
            } else if (error.code === error.TIMEOUT) {
              setLocationSyncError(mapGeolocationError(error));
              appendSyncLog("Geolocation timed out.");
            } else {
              setLocationSyncError(mapGeolocationError(error));
              appendSyncLog(`Geolocation error: ${error.message || "unknown"}`);
            }
            finish();
          },
          {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0,
          }
        );
      });
    } finally {
      syncInFlightRef.current = false;
      setSyncingLocation(false);
      appendSyncLog("Sync ended.");
    }
  }, [appendSyncLog, responderUid]);

  useEffect(() => {
    if (!responderUid) {
      return;
    }

    const triggerSync = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void syncResponderLocation();
    };

    // Kick off location sharing immediately, then refresh in the background.
    triggerSync();
    const intervalId = window.setInterval(triggerSync, 20000);

    window.addEventListener("online", triggerSync);
    document.addEventListener("visibilitychange", triggerSync);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("online", triggerSync);
      document.removeEventListener("visibilitychange", triggerSync);
    };
  }, [responderUid, syncResponderLocation]);

  const locationSharingState = useMemo(() => {
    if (!navigator.geolocation) {
      return { label: "Live location unavailable on this device", tone: "text-destructive" };
    }

    if (locationDocLoading) {
      return { label: "Checking live location status...", tone: "text-muted-foreground" };
    }

    if (locationSyncError) {
      return { label: locationSyncError, tone: "text-destructive" };
    }

    if (locationStatusError) {
      return { label: locationStatusError, tone: "text-destructive" };
    }

    if (lastSuccessfulSyncAt && nowTick - lastSuccessfulSyncAt.getTime() <= 60000) {
      return { label: "Currently sharing live location", tone: "text-success" };
    }

    if (!hasLiveCoordinates || !lastLiveUpdate) {
      return { label: "Live location not yet synced", tone: "text-warning" };
    }

    const ageMs = nowTick - lastLiveUpdate.getTime();
    if (ageMs <= 20000) {
      return { label: "Currently sharing live location", tone: "text-success" };
    }

    return { label: "Live location stale, attempting to resync", tone: "text-warning" };
  }, [hasLiveCoordinates, lastLiveUpdate, lastSuccessfulSyncAt, locationDocLoading, locationStatusError, locationSyncError, nowTick]);

  async function handleAcceptIncident(incidentId: string) {
    console.info("[ResponderDashboard] Accept tapped", { incidentId });
    await acceptIncident(incidentId);
    toast.success("Incident accepted.");
  }

  async function handleDeclineIncident(incidentId: string) {
    const reason = window.prompt("Reason for rejecting this incident:", "");
    if (reason === null) {
      return;
    }

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      toast.error("Please provide a rejection reason.");
      return;
    }

    await rejectIncident(incidentId, trimmedReason);
    toast.success("Incident declined.");
  }

  async function handleUpdateIncidentStatus(incidentId: string, status: ReportStatus) {
    console.info("[ResponderDashboard] Status toggle tapped", { incidentId, status });
    await updateIncidentStatus(incidentId, status);
    if (status === "resolved") {
      setResponderDutyStatus("Available");
    }
    toast.success("Incident status updated.");
  }

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

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="pb-8 px-4 pt-4 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs text-muted-foreground font-medium">Responder</p>
          <h1 className="text-lg font-bold text-foreground">{user?.name}</h1>
        </div>
        <button
          onClick={() => void handleLogout()}
          className="p-2 text-muted-foreground hover:text-foreground rounded-lg"
        >
          <LogOut size={20} />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-6">
        {[
          { label: "Active", count: active.length, color: "text-emergency" },
          { label: "En Route", count: incidents.filter((i) => i.status === "en_route").length, color: "text-info" },
          { label: "Resolved", count: resolved.length, color: "text-success" },
        ].map((s) => (
          <div key={s.label} className="bg-card rounded-xl border p-3 text-center">
            <p className={cn("text-2xl font-black", s.color)}>{s.count}</p>
            <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      <div className="mb-6 rounded-xl border bg-card p-3">
        <div className="flex items-center gap-2">
          <LocateFixed size={16} className={cn(locationSharingState.tone)} />
          <p className={cn("text-sm font-semibold", locationSharingState.tone)}>
            {locationSharingState.label}
          </p>
        </div>
        {lastLiveUpdate && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Last update: {lastLiveUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </p>
        )}
        {syncingLocation && <p className="mt-1 text-[11px] text-muted-foreground">Updating live location...</p>}
      </div>

      <div className="mb-6 rounded-xl border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">
            Duty Status: <span className="font-bold">{responderDutyStatus || "Unknown"}</span>
          </p>
          {responderDutyStatus === "Deployed" && (
            <span className="rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-info">
              On Incident
            </span>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void handleSetDutyStatus("Available")}
            disabled={isUpdatingDutyStatus || responderDutyStatus === "Deployed"}
            className={cn(
              "rounded-lg px-3 py-2 text-xs font-semibold",
              responderDutyStatus === "Available" ? "bg-success text-success-foreground" : "bg-secondary text-foreground",
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
              responderDutyStatus === "Off-Duty" ? "bg-muted text-foreground" : "bg-secondary text-foreground",
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

      {/* Active Incidents */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={16} className="text-emergency" />
          <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">
            Active Incidents
          </h2>
          {active.length > 0 && (
            <span className="bg-emergency text-emergency-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">
              {active.length}
            </span>
          )}
        </div>
        {active.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            No active incidents. Stand by.
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((inc) => (
              <IncidentCard
                key={inc.id}
                incident={inc}
                onViewDetails={() => navigate(`/responder/incidents/${inc.id}`)}
                onAccept={handleAcceptIncident}
                onDecline={handleDeclineIncident}
                onUpdateStatus={handleUpdateIncidentStatus}
              />
            ))}
          </div>
        )}
      </div>

      {/* Resolved */}
      {resolved.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider mb-3">
            Resolved
          </h2>
          <div className="space-y-2">
            {resolved.map((inc) => (
              <div key={inc.id} className="bg-card rounded-xl border p-3 opacity-60">
                <div className="flex items-center justify-between">
                  <CategoryIcon category={inc.category} size={16} showLabel />
                  <StatusBadge status={inc.status} />
                </div>
                <p className="text-xs text-muted-foreground mt-1 truncate">{inc.location}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SMS Fallback for Responder */}
      <div className="rounded-xl border-2 border-dashed border-warning bg-warning-light p-4">
        <h3 className="font-bold text-sm text-warning-foreground mb-2">Status Update via SMS</h3>
        <div className="bg-card rounded-lg p-3 font-mono text-xs border">
          <span className="text-info font-bold">STATUS</span>{" "}
          <span className="text-muted-foreground">&lt;incident_id&gt;</span>{" "}
          <span className="text-success font-bold">EN_ROUTE</span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          Send to: <span className="font-semibold text-foreground">911-RESP</span> · Statuses: EN_ROUTE, ON_SCENE, RESOLVED
        </p>
      </div>
    </div>
  );
}

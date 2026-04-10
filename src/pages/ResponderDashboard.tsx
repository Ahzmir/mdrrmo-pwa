import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useIncidents } from "@/hooks/useIncidents";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { SmsFallback } from "@/components/SmsFallback";
import { auth, db } from "@/lib/firebase";
import { Timestamp, collection, doc, limit, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import {
  AlertTriangle,
  LocateFixed,
  MapPin,
} from "lucide-react";
import { IncidentReport } from "@/types/incident";
import { cn } from "@/lib/utils";

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

function IncidentCard({
  incident,
  onViewDetails,
}: {
  incident: IncidentReport;
  onViewDetails?: () => void;
}) {
  const canViewDetails = !!incident.coordinates;

  const awaitingDecision = incident.responderAssignmentStatus === "assigned";

  return (
    <div
      onClick={canViewDetails ? onViewDetails : undefined}
      className={cn(
        "space-y-3 rounded-xl border border-white/55 bg-white/60 p-4 backdrop-blur-md transition-all",
        canViewDetails && "cursor-pointer hover:border-orange-300 hover:shadow-sm",
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

      {incident.photoUrl ? (
        <img
          src={incident.photoUrl}
          alt="Resident incident attachment"
          className="h-40 w-full rounded-lg border border-white/60 object-cover"
          loading="lazy"
        />
      ) : null}

      <p className="text-sm text-foreground line-clamp-2">{incident.description}</p>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MapPin size={13} className="shrink-0" />
        <span className="truncate">{incident.location}</span>
      </div>

      <p className="text-xs text-muted-foreground">Tap to view incident details and respond.</p>
    </div>
  );
}

export default function ResponderDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
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
            setLastLiveUpdate((previous) => nextLastUpdate ?? previous);
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
          setLastLiveUpdate((previous) => nextLastUpdate ?? previous);
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

  return (
    <div className="mx-auto max-w-lg bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-4 pb-24">
      {/* Header */}
      <div className="mb-6 rounded-2xl border border-white/45 bg-white/45 p-4 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <div>
          <p className="text-xs text-muted-foreground font-medium">Responder</p>
          <h1 className="text-lg font-bold text-orange-600">{user?.name}</h1>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-white/55 bg-white/60 p-3 backdrop-blur-md">
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

      {/* Active Incidents */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={16} className="text-orange-600" />
          <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">
            Active Incidents
          </h2>
          {active.length > 0 && (
            <span className="rounded-full bg-orange-600 px-2 py-0.5 text-[10px] font-bold text-white">
              {active.length}
            </span>
          )}
        </div>
        {active.length === 0 ? (
          <div className="rounded-xl border border-white/55 bg-white/55 py-10 text-center text-sm text-muted-foreground backdrop-blur-md">
            No active incidents. Stand by.
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((inc) => (
              <IncidentCard
                key={inc.id}
                incident={inc}
                onViewDetails={() => navigate(`/responder/incidents/${inc.id}`)}
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
              <div key={inc.id} className="rounded-xl border border-white/55 bg-white/55 p-3 opacity-60 backdrop-blur-md">
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

    </div>
  );
}

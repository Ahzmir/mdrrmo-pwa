import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Inbox, Loader2, MapPin, Route } from "lucide-react";
import { useReports } from "@/hooks/useReports";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { db } from "@/lib/firebase";
import { loadGoogleMapsApi } from "@/lib/googleMaps";
import { Timestamp, collection, doc, onSnapshot } from "firebase/firestore";

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

type LatLng = [number, number];

type ResponderLiveRow = {
  uid: string;
  lat: number;
  lng: number;
  updatedAt: Date | null;
};

type ResponderNameDirectory = Map<string, string>;

type ResponderRouteRow = {
  uid: string;
  lat: number;
  lng: number;
  updatedAt: Date | null;
  points: LatLng[];
  distanceMeters: number | null;
  durationSeconds: number | null;
};

type RouteProgressState = "near" | "approaching" | "en_route" | "moving_away";

type GoogleRoutesApiResponse = {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
  }>;
};

function toNullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseDurationSeconds(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.replace(/s$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

function haversineMeters(a: LatLng, b: LatLng) {
  const R = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const sinDlat = Math.sin(dLat / 2);
  const sinDlng = Math.sin(dLng / 2);
  const h = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlng * sinDlng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function ResidentRouteMap({
  incident,
  routes,
  responderNames,
}: {
  incident: { lat: number; lng: number };
  routes: ResponderRouteRow[];
  responderNames: ResponderNameDirectory;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current || mapRef.current) {
      return;
    }

    void loadGoogleMapsApi().then(() => {
      if (cancelled || !containerRef.current) {
        return;
      }

      mapRef.current = new google.maps.Map(containerRef.current, {
        center: { lat: incident.lat, lng: incident.lng },
        zoom: 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: "greedy",
        mapId: import.meta.env.VITE_GOOGLE_MAP_ID || "DEMO_MAP_ID",
      });
    }).catch(() => {
      // Parent UI already shows route fallback info.
    });

    return () => {
      cancelled = true;
      mapRef.current = null;
    };
  }, [incident.lat, incident.lng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const incidentMarker = new google.maps.Marker({
      map,
      position: { lat: incident.lat, lng: incident.lng },
      title: "Incident location",
      zIndex: 900,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: "#ef4444",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 3,
        scale: 9,
      },
    });

    const routePolylines: google.maps.Polyline[] = [];
    const responderMarkers: google.maps.Marker[] = [];
    const bounds = new google.maps.LatLngBounds();
    bounds.extend({ lat: incident.lat, lng: incident.lng });

    routes.forEach((route) => {
      const responderMarker = new google.maps.Marker({
        map,
        position: { lat: route.lat, lng: route.lng },
        title: responderNames.get(route.uid) || "Assigned responder",
        zIndex: 850,
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          fillColor: "#2563eb",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
          scale: 6,
        },
      });
      responderMarkers.push(responderMarker);
      bounds.extend({ lat: route.lat, lng: route.lng });

      const polylinePoints = route.points.length ? route.points : [[route.lat, route.lng], [incident.lat, incident.lng]];
      polylinePoints.forEach((point) => bounds.extend({ lat: point[0], lng: point[1] }));

      const polyline = new google.maps.Polyline({
        map,
        path: polylinePoints.map((point) => ({ lat: point[0], lng: point[1] })),
        strokeColor: "#2563eb",
        strokeOpacity: 0.9,
        strokeWeight: 5,
        zIndex: 500,
      });
      routePolylines.push(polyline);
    });

    map.fitBounds(bounds, 56);

    return () => {
      incidentMarker.setMap(null);
      responderMarkers.forEach((marker) => marker.setMap(null));
      routePolylines.forEach((polyline) => polyline.setMap(null));
    };
  }, [incident.lat, incident.lng, responderNames, routes]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function toLiveCoordinate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const map = value as Record<string, unknown>;
  const latRaw = map.latitude ?? map.lat;
  const lngRaw = map.longitude ?? map.lng;

  if (typeof latRaw !== "number" || typeof lngRaw !== "number") {
    return null;
  }

  return { lat: latRaw, lng: lngRaw };
}

export default function MyReports() {
  const navigate = useNavigate();
  const reports = useReports();
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [liveByResponderId, setLiveByResponderId] = useState<Map<string, ResponderLiveRow>>(
    () => new Map()
  );
  const [responderNames, setResponderNames] = useState<ResponderNameDirectory>(() => new Map());
  const [routeRows, setRouteRows] = useState<ResponderRouteRow[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [progressByResponder, setProgressByResponder] = useState<Map<string, RouteProgressState>>(
    () => new Map()
  );
  const previousDistanceByResponderRef = useRef<Map<string, number>>(new Map());

  const selectedReport = useMemo(
    () => reports.find((report) => report.id === selectedReportId) || null,
    [selectedReportId, reports]
  );

  useEffect(() => {
    const respondersRef = collection(db, "responders");
    const unsubscribe = onSnapshot(
      respondersRef,
      (snapshot) => {
        const directory = new Map<string, string>();

        snapshot.docs.forEach((responderDoc) => {
          const data = responderDoc.data() as Record<string, unknown>;
          const name =
            typeof data.name === "string" && data.name.trim().length > 0
              ? data.name.trim()
              : "Responder";
          const authUid =
            typeof data.uid === "string" && data.uid.trim().length > 0
              ? data.uid.trim()
              : responderDoc.id;

          directory.set(responderDoc.id, name);
          directory.set(authUid, name);
        });

        setResponderNames(directory);
      },
      () => {
        setResponderNames(new Map());
      }
    );

    return () => unsubscribe();
  }, []);

  function normalizeDisplayName(value: string) {
    const cleaned = value
      .replace(/[_\-.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) {
      return "";
    }

    return cleaned
      .split(" ")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function toDisplayNameFromEmail(email: string) {
    const atIndex = email.indexOf("@");
    const local = atIndex > 0 ? email.slice(0, atIndex) : email;
    return normalizeDisplayName(local);
  }

  function assignedResponderNames(report: {
    assignedResponders?: string[];
    assignedResponderNames?: string[];
    assignedResponderEmails?: string[];
  }) {
    const explicitNames = (report.assignedResponderNames || [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (explicitNames.length > 0) {
      return Array.from(new Set(explicitNames));
    }

    const assignedIds = report.assignedResponders || [];
    if (assignedIds.length === 0) {
      return [];
    }

    const directoryNames = assignedIds
      .map((id) => responderNames.get(id))
      .filter((name): name is string => !!name && name.trim().length > 0)
      .map((name) => name.trim());

    const emailNames = (report.assignedResponderEmails || [])
      .map((email) => toDisplayNameFromEmail(email))
      .filter((name) => name.length > 0);

    const mergedNames = [...directoryNames, ...emailNames];
    if (mergedNames.length > 0) {
      return Array.from(new Set(mergedNames));
    }

    return ["Assigned responder"];
  }

  useEffect(() => {
    const liveLocationsRef = collection(db, "responderLiveLocations");
    const unsubscribe = onSnapshot(
      liveLocationsRef,
      (snapshot) => {
        const next = new Map<string, ResponderLiveRow>();

        snapshot.docs.forEach((liveDoc) => {
          const data = liveDoc.data() as Record<string, unknown>;
          const coord = toLiveCoordinate(data.liveLocation);
          if (!coord) {
            return;
          }

          const uidFromDoc =
            typeof data.uid === "string" && data.uid.trim().length > 0 ? data.uid.trim() : liveDoc.id;
          const row: ResponderLiveRow = {
            uid: uidFromDoc,
            lat: coord.lat,
            lng: coord.lng,
            updatedAt: toDate(data.liveLocationUpdatedAt),
          };

          next.set(liveDoc.id, row);
          next.set(uidFromDoc, row);
        });

        setLiveByResponderId(next);
      },
      () => {
        setLiveByResponderId(new Map());
      }
    );

    return () => unsubscribe();
  }, []);

  const responderLiveRows = useMemo(() => {
    const assignedIds = selectedReport?.assignedResponders || [];
    if (assignedIds.length === 0) {
      return [] as ResponderLiveRow[];
    }

    const dedupedRows = new Map<string, ResponderLiveRow>();
    assignedIds.forEach((id) => {
      const row = liveByResponderId.get(id);
      if (row) {
        dedupedRows.set(row.uid, row);
      }
    });

    return Array.from(dedupedRows.values());
  }, [selectedReport?.assignedResponders, liveByResponderId]);

  const shouldShowResidentTracking =
    !!selectedReport &&
    !!selectedReport.coordinates &&
    (selectedReport.assignedResponders?.length || 0) > 0 &&
    ["assigned", "en_route", "on_scene"].includes(selectedReport.status);

  useEffect(() => {
    if (!shouldShowResidentTracking || !selectedReport?.coordinates) {
      setRouteRows([]);
      setRouteLoading(false);
      setRouteError(null);
      setProgressByResponder(new Map());
      previousDistanceByResponderRef.current.clear();
      return;
    }

    if (responderLiveRows.length === 0) {
      setRouteRows([]);
      setRouteLoading(false);
      setRouteError(null);
      setProgressByResponder(new Map());
      return;
    }

    let cancelled = false;
    setRouteLoading(true);
    setRouteError(null);

    const incidentPoint: LatLng = [selectedReport.coordinates.lat, selectedReport.coordinates.lng];

    const fetchRoutes = async () => {
      const rows = await Promise.all(
        responderLiveRows.map(async (live): Promise<ResponderRouteRow> => {
          const fallbackDistance = haversineMeters([live.lat, live.lng], incidentPoint);
          const fallbackDuration = Math.max(60, (fallbackDistance / 1000 / 35) * 3600);

          if (!GOOGLE_MAPS_API_KEY) {
            return {
              uid: live.uid,
              lat: live.lat,
              lng: live.lng,
              updatedAt: live.updatedAt,
              points: [[live.lat, live.lng], incidentPoint],
              distanceMeters: fallbackDistance,
              durationSeconds: fallbackDuration,
            };
          }

          try {
            const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
                "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
              },
              body: JSON.stringify({
                origin: {
                  location: {
                    latLng: { latitude: live.lat, longitude: live.lng },
                  },
                },
                destination: {
                  location: {
                    latLng: {
                      latitude: incidentPoint[0],
                      longitude: incidentPoint[1],
                    },
                  },
                },
                travelMode: "DRIVE",
                routingPreference: "TRAFFIC_AWARE_OPTIMAL",
                computeAlternativeRoutes: false,
                units: "METRIC",
                regionCode: "PH",
              }),
            });

            if (!response.ok) {
              throw new Error(`Routes request failed (${response.status})`);
            }

            const result = (await response.json()) as GoogleRoutesApiResponse;
            const route = result.routes?.[0];
            const encoded = route?.polyline?.encodedPolyline;
            const decodedPoints = encoded ? decodePolyline(encoded) : [[live.lat, live.lng], incidentPoint];

            return {
              uid: live.uid,
              lat: live.lat,
              lng: live.lng,
              updatedAt: live.updatedAt,
              points: decodedPoints,
              distanceMeters: toNullableNumber(route?.distanceMeters) ?? fallbackDistance,
              durationSeconds: parseDurationSeconds(route?.duration) ?? fallbackDuration,
            };
          } catch {
            return {
              uid: live.uid,
              lat: live.lat,
              lng: live.lng,
              updatedAt: live.updatedAt,
              points: [[live.lat, live.lng], incidentPoint],
              distanceMeters: fallbackDistance,
              durationSeconds: fallbackDuration,
            };
          }
        })
      );

      if (cancelled) {
        return;
      }

      setRouteRows(rows);
      setRouteLoading(false);
      if (!GOOGLE_MAPS_API_KEY) {
        setRouteError("Google Maps key is missing. Showing approximate straight-line ETA.");
      }
    };

    void fetchRoutes();

    return () => {
      cancelled = true;
    };
  }, [responderLiveRows, selectedReport?.coordinates, shouldShowResidentTracking]);

  useEffect(() => {
    if (!selectedReport?.coordinates || routeRows.length === 0) {
      setProgressByResponder(new Map());
      return;
    }

    const next = new Map<string, RouteProgressState>();
    const previousMap = previousDistanceByResponderRef.current;

    routeRows.forEach((row) => {
      const currentDistance = row.distanceMeters ?? haversineMeters([row.lat, row.lng], [selectedReport.coordinates!.lat, selectedReport.coordinates!.lng]);
      const previousDistance = previousMap.get(row.uid);

      if (currentDistance <= 180) {
        next.set(row.uid, "near");
      } else if (previousDistance !== undefined && currentDistance <= previousDistance - 20) {
        next.set(row.uid, "approaching");
      } else if (previousDistance !== undefined && currentDistance >= previousDistance + 20) {
        next.set(row.uid, "moving_away");
      } else {
        next.set(row.uid, "en_route");
      }

      previousMap.set(row.uid, currentDistance);
    });

    setProgressByResponder(next);
  }, [routeRows, selectedReport?.coordinates]);

  return (
    <div className="mx-auto max-w-lg bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-4 pb-24 animate-fade-in">
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/45 bg-white/45 px-3 py-3 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <button onClick={() => navigate(-1)} className="p-1 text-muted-foreground">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-orange-600">My Reports</h1>
      </div>

      {reports.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/45 bg-white/45 py-20 text-center shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/65">
            <Inbox size={28} className="text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            No reports yet. Tap "Report Incident" to submit one.
          </p>
          <button
            onClick={() => navigate("/report")}
            className="mt-2 rounded-xl bg-orange-600 px-6 py-3 text-sm font-semibold text-white"
          >
            Report Now
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => {
            const assignedNames = assignedResponderNames(r);
            return (
              <button
                key={r.id}
                onClick={() => setSelectedReportId(r.id)}
                className="w-full space-y-2 rounded-xl border border-white/50 bg-white/60 p-4 text-left backdrop-blur-md transition-all hover:border-orange-300"
              >
                {assignedNames.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Assigned to: <span className="font-semibold text-foreground">{assignedNames.join(", ")}</span>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Assigned to: Waiting for assignment</p>
                )}

                <div className="flex items-center justify-between">
                  <CategoryIcon category={r.category} size={18} showLabel />
                  {r.offlineSmsPending ? (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold tracking-wide uppercase text-amber-800">
                      Offline SMS
                    </span>
                  ) : (
                    <StatusBadge status={r.status} />
                  )}
                </div>
                {r.photoUrl && (
                  <img
                    src={r.photoUrl}
                    alt="Reported incident"
                    loading="lazy"
                    className="w-full h-40 object-cover rounded-lg border"
                  />
                )}
                {r.description && (
                  <p className="text-sm text-foreground">{r.description}</p>
                )}
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{r.location}</span>
                  <span>
                    {r.createdAt.toLocaleDateString()} {r.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Dialog open={!!selectedReport} onOpenChange={(open) => !open && setSelectedReportId(null)}>
        <DialogContent className="w-[calc(100%-2rem)] max-h-[88vh] max-w-lg overflow-y-auto rounded-2xl border border-white/55 bg-white/90 backdrop-blur-xl">
          {selectedReport ? (
            <div className="space-y-3">
              <DialogHeader>
                <DialogTitle>Report Details</DialogTitle>
              </DialogHeader>

              <p className="text-[11px] text-muted-foreground">
                Assigned Responder(s):{" "}
                <span className="font-semibold text-foreground">
                  {assignedResponderNames(selectedReport).length > 0
                    ? assignedResponderNames(selectedReport).join(", ")
                    : "None yet"}
                </span>
              </p>

              <div className="flex items-center justify-between">
                <CategoryIcon category={selectedReport.category} size={18} showLabel />
                {selectedReport.offlineSmsPending ? (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold tracking-wide uppercase text-amber-800">
                    Offline SMS
                  </span>
                ) : (
                  <StatusBadge status={selectedReport.status} />
                )}
              </div>

              {selectedReport.photoUrl && (
                <img
                  src={selectedReport.photoUrl}
                  alt="Reported incident"
                  loading="lazy"
                  className="h-40 w-full rounded-lg border object-cover"
                />
              )}

              {selectedReport.description && (
                <p className="text-sm text-foreground">{selectedReport.description}</p>
              )}

              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{selectedReport.location}</span>
                <span>
                  {selectedReport.createdAt.toLocaleDateString()} {selectedReport.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                <p>Report ID: <span className="font-semibold text-foreground">{selectedReport.id}</span></p>
                <p>Assigned Responders: <span className="font-semibold text-foreground">{selectedReport.assignedResponders?.length || 0}</span></p>
                <p>
                  Last Update: <span className="font-semibold text-foreground">{(selectedReport.updatedAt || selectedReport.createdAt).toLocaleString()}</span>
                </p>
                <p>
                  Resolved At: <span className="font-semibold text-foreground">{selectedReport.resolvedAt ? selectedReport.resolvedAt.toLocaleString() : "Not yet"}</span>
                </p>
                {selectedReport.offlineSmsPending ? (
                  <p className="col-span-2">
                    SMS Target: <span className="font-semibold text-foreground">{selectedReport.smsNumber || "Unknown"}</span>
                  </p>
                ) : null}
              </div>

              {selectedReport.coordinates ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Route size={13} />
                    Responder Route to Incident
                  </div>

                  {!shouldShowResidentTracking ? (
                    <p className="text-xs text-muted-foreground">
                      Tracking appears when this report is active and has an assigned responder.
                    </p>
                  ) : responderLiveRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Waiting for assigned responder live location updates.
                    </p>
                  ) : (
                    <>
                      {routeLoading ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 size={14} className="animate-spin" />
                          Calculating responder route ETA...
                        </div>
                      ) : null}

                      {routeError ? <p className="text-xs text-amber-700">{routeError}</p> : null}

                      <div className="h-56 overflow-hidden rounded-lg border">
                        <ResidentRouteMap
                          incident={{ lat: selectedReport.coordinates.lat, lng: selectedReport.coordinates.lng }}
                          routes={routeRows}
                          responderNames={responderNames}
                        />
                      </div>

                      <div className="space-y-1">
                        {routeRows.map((row) => {
                          const progress = progressByResponder.get(row.uid) || "en_route";
                          const progressLabel =
                            progress === "near"
                              ? "Near incident"
                              : progress === "approaching"
                                ? "Approaching"
                                : progress === "moving_away"
                                  ? "Moving away"
                                  : "En route";

                          return (
                          <div key={`${row.uid}-meta`} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <MapPin size={12} />
                            <span className="font-semibold text-foreground">
                              {responderNames.get(row.uid) || "Assigned responder"}
                            </span>
                            <span>
                              ETA {row.durationSeconds !== null ? formatDuration(row.durationSeconds) : "N/A"}
                            </span>
                            <span>
                              ({row.distanceMeters !== null ? formatDistance(row.distanceMeters) : "N/A"})
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                              {progressLabel}
                            </span>
                          </div>
                        );})}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Incident coordinates are unavailable.</p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

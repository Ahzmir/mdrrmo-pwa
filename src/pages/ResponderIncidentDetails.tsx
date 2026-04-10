import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  Loader2,
  MapPin,
  Route,
  TriangleAlert,
} from "lucide-react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import { useIncidents } from "@/hooks/useIncidents";
import { acceptIncident, markIncidentOnScene, rejectIncident, updateIncidentStatus } from "@/stores/incidentStore";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { toast } from "sonner";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const GEOAPIFY_API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY;
const ARRIVAL_RADIUS_METERS = 120;

type LatLng = [number, number];
type RouteInstruction = {
  id: string;
  text: string;
  distance: number | null;
  duration: number | null;
};

type RouteOption = {
  id: string;
  points: LatLng[];
  distance: number | null;
  duration: number | null;
  instructions: RouteInstruction[];
  source: "geoapify" | "fallback";
};

const responderMarkerIcon = L.icon({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function formatDistance(meters: number) {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.round(meters)} m`;
}

function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
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

function normalizeInstructionText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  return text.length ? text : null;
}

function RouteViewport({
  points,
  followPoint,
}: {
  points: LatLng[];
  followPoint?: LatLng | null;
}) {
  const map = useMap();
  const hasIntroAnimatedRef = useRef(false);
  const lastFollowAnimationAtRef = useRef(0);

  useEffect(() => {
    if (points.length < 2) {
      return;
    }

    const bounds = L.latLngBounds(points);
    if (!hasIntroAnimatedRef.current) {
      // Initial cinematic fly-in to show both responder and destination.
      map.flyToBounds(bounds.pad(0.18), {
        duration: 1.2,
        easeLinearity: 0.25,
        maxZoom: 16,
      });
      hasIntroAnimatedRef.current = true;
      return;
    }

    map.fitBounds(bounds.pad(0.15), { animate: true, duration: 0.65, maxZoom: 16 });
  }, [map, points]);

  useEffect(() => {
    if (!followPoint || !hasIntroAnimatedRef.current) {
      return;
    }

    const now = Date.now();
    // Throttle follow-camera animation so live GPS updates don't feel jittery.
    if (now - lastFollowAnimationAtRef.current < 2200) {
      return;
    }

    lastFollowAnimationAtRef.current = now;
    map.flyTo(followPoint, Math.max(map.getZoom(), 15), {
      duration: 0.9,
      easeLinearity: 0.25,
      noMoveStart: true,
    });
  }, [followPoint, map]);

  return null;
}

export default function ResponderIncidentDetails() {
  const navigate = useNavigate();
  const { incidentId } = useParams<{ incidentId: string }>();
  const incidents = useIncidents();

  const incident = useMemo(
    () => incidents.find((i) => i.id === incidentId),
    [incidents, incidentId]
  );

  const [currentPosition, setCurrentPosition] = useState<LatLng | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [locating, setLocating] = useState(true);

  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [showRouteDetails, setShowRouteDetails] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeRefreshToken, setRouteRefreshToken] = useState(0);
  const lastRouteKeyRef = useRef<string | null>(null);
  const [acceptedLocally, setAcceptedLocally] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [isFullscreenMapOpen, setIsFullscreenMapOpen] = useState(false);
  const autoOnSceneInFlightRef = useRef(false);

  const destination = useMemo(() => {
    if (!incident?.coordinates) return null;
    return [incident.coordinates.lat, incident.coordinates.lng] as LatLng;
  }, [incident?.coordinates?.lat, incident?.coordinates?.lng]);
  const awaitingDecision = incident?.responderAssignmentStatus === "assigned";
  const hasGeoapifyKey = typeof GEOAPIFY_API_KEY === "string" && GEOAPIFY_API_KEY.trim().length > 0;
  const currentLat = currentPosition?.[0] ?? null;
  const currentLng = currentPosition?.[1] ?? null;
  const destinationLat = destination?.[0] ?? null;
  const destinationLng = destination?.[1] ?? null;
  const fallbackDistance = useMemo(() => {
    if (!currentPosition || !destination) return null;
    return haversineMeters(currentPosition, destination);
  }, [currentPosition, destination]);
  const fallbackDuration = useMemo(() => {
    if (fallbackDistance === null) return null;
    const assumedKph = 35;
    return Math.max(60, (fallbackDistance / 1000 / assumedKph) * 3600);
  }, [fallbackDistance]);
  const selectedRoute = useMemo(() => {
    if (!routeOptions.length) return null;
    if (!selectedRouteId) return routeOptions[0];
    return routeOptions.find((option) => option.id === selectedRouteId) || routeOptions[0];
  }, [routeOptions, selectedRouteId]);

  const fastestRouteId = useMemo(() => {
    if (!routeOptions.length) return null;

    const ranked = [...routeOptions].sort((a, b) => {
      const aDuration = a.duration ?? Number.POSITIVE_INFINITY;
      const bDuration = b.duration ?? Number.POSITIVE_INFINITY;
      return aDuration - bDuration;
    });

    return ranked[0]?.id ?? null;
  }, [routeOptions]);

  const shownDistance = selectedRoute?.distance ?? fallbackDistance;
  const shownDuration = selectedRoute?.duration ?? fallbackDuration;
  const routeApproximate = selectedRoute?.source === "fallback" || shownDistance === null || shownDuration === null;
  const selectedRouteInstructions = selectedRoute?.instructions ?? [];
  const nextInstruction = selectedRouteInstructions[0] ?? null;

  useEffect(() => {
    setShowRouteDetails(false);
    setAcceptedLocally(false);
    setDeclineOpen(false);
    setDeclineReason("");
    setIsFullscreenMapOpen(false);
    autoOnSceneInFlightRef.current = false;
  }, [incidentId]);

  useEffect(() => {
    if (!incident || !destination || !currentPosition) {
      return;
    }

    if (incident.status !== "en_route") {
      return;
    }

    if (autoOnSceneInFlightRef.current) {
      return;
    }

    const distanceToIncident = haversineMeters(currentPosition, destination);
    if (!Number.isFinite(distanceToIncident) || distanceToIncident > ARRIVAL_RADIUS_METERS) {
      return;
    }

    autoOnSceneInFlightRef.current = true;
    void markIncidentOnScene(incident.id).catch((error) => {
      autoOnSceneInFlightRef.current = false;
      toast.error((error as Error).message || "Unable to auto-update incident to On Scene.");
    });
  }, [incident, currentPosition, destination]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setPositionError("Geolocation is not supported on this device.");
      setLocating(false);
      return;
    }

    setLocating(true);
    setPositionError(null);

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setCurrentPosition([pos.coords.latitude, pos.coords.longitude]);
        setLocating(false);
        setPositionError(null);
      },
      (error) => {
        setPositionError(error.message || "Unable to detect current location.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  useEffect(() => {
    if (
      currentLat === null ||
      currentLng === null ||
      destinationLat === null ||
      destinationLng === null
    ) {
      return;
    }

    const routeKey = `${currentLat.toFixed(5)},${currentLng.toFixed(5)}->${destinationLat.toFixed(5)},${destinationLng.toFixed(5)}`;
    if (lastRouteKeyRef.current === routeKey && routeRefreshToken === 0) {
      return;
    }

    if (!hasGeoapifyKey) {
      setRouteError("Geoapify key is missing. Showing straight-line fallback route.");
      setRouteOptions([
        {
          id: "fallback",
          points: [
            [currentLat, currentLng],
            [destinationLat, destinationLng],
          ],
          distance: fallbackDistance,
          duration: fallbackDuration,
          instructions: [],
          source: "fallback",
        },
      ]);
      setSelectedRouteId("fallback");
      lastRouteKeyRef.current = routeKey;
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12000);

    async function fetchRoute() {
      try {
        setRouteLoading(true);
        setRouteError(null);

        const waypoints = `${currentLat},${currentLng}|${destinationLat},${destinationLng}`;
        const url = `https://api.geoapify.com/v1/routing?waypoints=${encodeURIComponent(
          waypoints
        )}&mode=drive&apiKey=${GEOAPIFY_API_KEY}`;

        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Geoapify routing failed (${response.status}).`);
        }

        const data = await response.json();
        const features: Array<{
          geometry?: { type?: string; coordinates?: unknown };
          properties?: { distance?: unknown; time?: unknown };
        }> = Array.isArray(data?.features) ? data.features : [];

        if (!features.length) {
          throw new Error("No route was returned by Geoapify.");
        }

        const parsedRoutes: RouteOption[] = [];

        features.forEach((feature, index) => {
          const geometry = feature.geometry;
          const coordinates: LatLng[] = [];
          const instructions: RouteInstruction[] = [];
          const properties =
            feature.properties && typeof feature.properties === "object"
              ? (feature.properties as Record<string, unknown>)
              : {};

          const legs = Array.isArray(properties.legs) ? (properties.legs as Array<Record<string, unknown>>) : [];
          legs.forEach((leg, legIndex) => {
            const steps = Array.isArray(leg.steps) ? (leg.steps as Array<Record<string, unknown>>) : [];
            steps.forEach((step, stepIndex) => {
              const instructionContainer =
                step.instruction && typeof step.instruction === "object"
                  ? (step.instruction as Record<string, unknown>)
                  : null;

              const text =
                normalizeInstructionText(instructionContainer?.text) ||
                normalizeInstructionText(step.instruction) ||
                normalizeInstructionText(step.maneuver) ||
                normalizeInstructionText(step.name) ||
                null;

              if (!text) {
                return;
              }

              instructions.push({
                id: `geoapify-${index}-leg-${legIndex}-step-${stepIndex}`,
                text,
                distance: toNullableNumber(step.distance),
                duration: toNullableNumber(step.time),
              });
            });
          });

          if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
            (geometry.coordinates as Array<[number, number]>).forEach((point) => {
              coordinates.push([point[1], point[0]]);
            });
          }

          if (geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
            (geometry.coordinates as Array<Array<[number, number]>>).forEach((segment) => {
              segment.forEach((point) => {
                coordinates.push([point[1], point[0]]);
              });
            });
          }

          if (!coordinates.length) {
            return;
          }

          parsedRoutes.push({
            id: `geoapify-${index}`,
            points: coordinates,
            distance: toNullableNumber(feature.properties?.distance),
            duration: toNullableNumber(feature.properties?.time),
            instructions,
            source: "geoapify",
          });
        });

        if (!parsedRoutes.length) {
          throw new Error("Route geometry was empty.");
        }

        const ranked = [...parsedRoutes].sort((a, b) => {
          const aDuration = a.duration ?? Number.POSITIVE_INFINITY;
          const bDuration = b.duration ?? Number.POSITIVE_INFINITY;
          return aDuration - bDuration;
        });

        setRouteOptions(ranked);
        setSelectedRouteId((previous) => {
          if (previous && ranked.some((route) => route.id === previous)) {
            return previous;
          }
          return ranked[0]?.id ?? null;
        });
        lastRouteKeyRef.current = routeKey;
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setRouteError((error as Error).message || "Unable to compute route.");
          setRouteOptions([
            {
              id: "fallback",
              points: [
                [currentLat, currentLng],
                [destinationLat, destinationLng],
              ],
              distance: fallbackDistance,
              duration: fallbackDuration,
              instructions: [],
              source: "fallback",
            },
          ]);
          setSelectedRouteId("fallback");
          lastRouteKeyRef.current = routeKey;
        } else {
          setRouteError("Routing request timed out. Showing approximate route.");
          setRouteOptions([
            {
              id: "fallback",
              points: [
                [currentLat, currentLng],
                [destinationLat, destinationLng],
              ],
              distance: fallbackDistance,
              duration: fallbackDuration,
              instructions: [],
              source: "fallback",
            },
          ]);
          setSelectedRouteId("fallback");
          lastRouteKeyRef.current = routeKey;
        }
      } finally {
        window.clearTimeout(timeoutId);
        setRouteLoading(false);
      }
    }

    fetchRoute();

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    currentLat,
    currentLng,
    destinationLat,
    destinationLng,
    fallbackDistance,
    fallbackDuration,
    hasGeoapifyKey,
    routeRefreshToken,
  ]);

  if (!incident) {
    return (
      <div className="px-4 pt-6 max-w-lg mx-auto">
        <button
          onClick={() => navigate("/responder")}
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </button>
        <div className="mt-8 rounded-xl border p-4 bg-card">
          <p className="font-semibold text-foreground">Incident not found.</p>
          <p className="text-sm text-muted-foreground mt-1">
            The selected incident may have been removed.
          </p>
        </div>
      </div>
    );
  }

  const acceptedOrBeyond =
    incident.responderAssignmentStatus === "accepted" ||
    incident.status === "en_route" ||
    incident.status === "on_scene" ||
    incident.status === "resolved";
  const canGetDirections = !awaitingDecision && (acceptedLocally || acceptedOrBeyond);
  const mapCenter = currentPosition || destination;

  async function handleAcceptIncident() {
    setSubmittingDecision(true);
    try {
      await acceptIncident(incident.id);
      setAcceptedLocally(true);
      setDeclineOpen(false);
      toast.success("Incident accepted.");
    } catch (error) {
      toast.error((error as Error).message || "Unable to accept incident.");
    } finally {
      setSubmittingDecision(false);
    }
  }

  async function handleDeclineSubmit() {
    const trimmedReason = declineReason.trim();
    if (!trimmedReason) {
      toast.error("Please provide a rejection reason.");
      return;
    }

    setSubmittingDecision(true);
    try {
      await rejectIncident(incident.id, trimmedReason);
      toast.success("Incident declined.");
      navigate("/responder", { replace: true });
    } catch (error) {
      toast.error((error as Error).message || "Unable to decline incident.");
    } finally {
      setSubmittingDecision(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-3 pb-24">
      <div className="flex items-center gap-3 rounded-2xl border border-white/45 bg-white/45 p-3 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <button
          onClick={() => navigate("/responder")}
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-orange-600">Assigned Incident Details</h1>
      </div>

      <div className="space-y-3 rounded-xl border border-white/55 bg-white/55 p-4 shadow-[0_18px_42px_-30px_rgba(15,23,42,0.45)] backdrop-blur-md">
        <div className="flex items-center justify-between">
          <CategoryIcon category={incident.category} size={20} showLabel />
          <StatusBadge status={incident.status} />
        </div>

        <p className="text-sm text-foreground leading-relaxed">{incident.description}</p>

        {incident.photoUrl ? (
          <img
            src={incident.photoUrl}
            alt="Resident incident attachment"
            className="h-48 w-full rounded-lg border border-white/60 object-cover"
            loading="lazy"
          />
        ) : null}

        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <MapPin size={14} className="mt-0.5 shrink-0" />
          <span>{incident.location}</span>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Clock size={12} />
          <span>
            {incident.createdAt.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>

        {awaitingDecision && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => void handleAcceptIncident()}
                disabled={submittingDecision}
                className="w-full rounded-xl bg-orange-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-70"
              >
                Yes, Accept
              </button>
              <button
                onClick={() => {
                  setDeclineOpen((current) => !current);
                  if (declineOpen) {
                    setDeclineReason("");
                  }
                }}
                disabled={submittingDecision}
                className="w-full rounded-xl border border-slate-900/90 bg-slate-800/95 px-3 py-2 text-xs font-semibold text-slate-100 disabled:opacity-70"
              >
                No, Decline
              </button>
            </div>

            {declineOpen && (
              <div className="space-y-2 rounded-lg border border-white/60 bg-white/70 p-3">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Decline reason
                </label>
                <textarea
                  value={declineReason}
                  onChange={(event) => setDeclineReason(event.target.value)}
                  rows={3}
                  placeholder="Explain why you are declining this incident."
                  className="w-full resize-none rounded-lg border border-white/60 bg-white/80 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-orange-300"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setDeclineOpen(false);
                      setDeclineReason("");
                    }}
                    type="button"
                    className="rounded-lg border border-white/60 bg-white px-3 py-1.5 text-xs font-semibold text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleDeclineSubmit()}
                    type="button"
                    disabled={submittingDecision}
                    className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-70"
                  >
                    Submit Decline
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {canGetDirections && (
          <button
            type="button"
            onClick={() => {
              if (fastestRouteId) {
                setSelectedRouteId(fastestRouteId);
              }
              setShowRouteDetails(true);
              setIsFullscreenMapOpen(true);
            }}
            className="w-full rounded-xl bg-orange-600 px-3 py-2 text-xs font-semibold text-white"
          >
            Get Directions
          </button>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-white/55 bg-white/55 p-4 shadow-[0_18px_42px_-30px_rgba(15,23,42,0.45)] backdrop-blur-md">
        <div className="flex items-center gap-2">
          <Route size={16} className="text-orange-600" />
          <h2 className="text-sm font-bold uppercase tracking-wider">Incident Location</h2>
        </div>

        {locating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground animate-slide-up">
            <Loader2 size={16} className="animate-spin" />
            Detecting your current location...
          </div>
        )}

        {positionError && (
          <div className="flex items-start gap-2 text-sm text-destructive animate-slide-up">
            <TriangleAlert size={16} className="mt-0.5" />
            <span>{positionError}</span>
          </div>
        )}

        {routeLoading && showRouteDetails && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground animate-slide-up">
            <Loader2 size={16} className="animate-spin" />
            Calculating drive route to scene...
          </div>
        )}

        {routeError && showRouteDetails && (
          <div className="flex items-start gap-2 text-sm text-destructive animate-slide-up">
            <TriangleAlert size={16} className="mt-0.5" />
            <span>{routeError}</span>
          </div>
        )}

        {showRouteDetails && !isFullscreenMapOpen && !locating && currentPosition && destination && (
          <div className="space-y-3 animate-slide-up">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Route updates on this page as your live location changes.
              </p>
              <button
                type="button"
                onClick={() => {
                  lastRouteKeyRef.current = null;
                  setRouteRefreshToken((current) => current + 1);
                }}
                className="rounded-lg border border-white/60 bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-foreground hover:bg-white/80"
              >
                Recalculate
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-white/60 bg-white/70 px-3 py-2 backdrop-blur-sm">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {routeApproximate ? "Distance (Approx)" : "Distance"}
                </p>
                <p className="text-sm font-semibold text-foreground">
                  {shownDistance !== null ? formatDistance(shownDistance) : "N/A"}
                </p>
              </div>
              <div className="rounded-lg border border-white/60 bg-white/70 px-3 py-2 backdrop-blur-sm">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {routeApproximate ? "ETA (Approx)" : "ETA"}
                </p>
                <p className="text-sm font-semibold text-foreground">
                  {shownDuration !== null ? formatDuration(shownDuration) : "N/A"}
                </p>
              </div>
            </div>

            {routeOptions.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Route options (fastest highlighted)
                </p>
                <div className="grid gap-2">
                  {routeOptions.map((route, index) => {
                    const isSelected = selectedRoute?.id === route.id;
                    const isFastest = fastestRouteId === route.id;

                    return (
                      <button
                        key={route.id}
                        type="button"
                        onClick={() => setSelectedRouteId(route.id)}
                        className={[
                          "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                          isSelected
                            ? "border-orange-300 bg-orange-100/70"
                            : "border-white/60 bg-white/65 hover:bg-white/75",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-foreground">
                            Route {index + 1}
                            {isFastest && (
                              <span className="ml-2 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-success">
                                Fastest ETA
                              </span>
                            )}
                          </p>
                          <p className="text-xs font-bold text-foreground">
                            {route.duration !== null ? formatDuration(route.duration) : "N/A"}
                          </p>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {route.distance !== null ? formatDistance(route.distance) : "N/A"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

          </div>
        )}

        {destination && mapCenter ? (
          <div className="h-72 overflow-hidden rounded-xl border border-white/60 bg-white/65 backdrop-blur-sm">
            <MapContainer center={mapCenter} zoom={13} scrollWheelZoom className="h-full w-full">
              <TileLayer
                url={
                  hasGeoapifyKey
                    ? `https://maps.geoapify.com/v1/tile/osm-carto/{z}/{x}/{y}.png?apiKey=${GEOAPIFY_API_KEY}`
                    : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                }
                attribution={
                  hasGeoapifyKey
                    ? "&copy; OpenStreetMap contributors | Tiles by Geoapify"
                    : "&copy; OpenStreetMap contributors"
                }
              />
              {currentPosition ? (
                <Marker position={currentPosition} icon={responderMarkerIcon}>
                  <Popup>Your current location</Popup>
                </Marker>
              ) : null}
              <Marker position={destination} icon={responderMarkerIcon}>
                <Popup>Incident scene</Popup>
              </Marker>
              {showRouteDetails && routeOptions.length > 0
                ? routeOptions.map((route) => {
                    const isSelected = selectedRoute?.id === route.id;
                    const isFastest = fastestRouteId === route.id;

                    return (
                      <Polyline
                        key={route.id}
                        positions={route.points}
                        pathOptions={{
                          color: isSelected ? "#f97316" : isFastest ? "#fb923c" : "#9ca3af",
                          weight: isSelected ? 6 : 4,
                          opacity: isSelected ? 0.95 : isFastest ? 0.65 : 0.4,
                          dashArray: isSelected ? undefined : "6 8",
                        }}
                      />
                    );
                  })
                : null}
              {showRouteDetails && currentPosition ? (
                <RouteViewport
                  points={
                    selectedRoute?.points?.length
                      ? selectedRoute.points
                      : [currentPosition, destination]
                  }
                  followPoint={currentPosition}
                />
              ) : null}
            </MapContainer>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Incident coordinates are unavailable.</p>
        )}

        {!showRouteDetails && canGetDirections && (
          <p className="text-xs text-muted-foreground">
            Tap <span className="font-semibold text-foreground">Get Directions</span> to reveal ETA and fastest route options.
          </p>
        )}

        {!hasGeoapifyKey && showRouteDetails && (
          <p className="text-xs text-muted-foreground">
            Add VITE_GEOAPIFY_API_KEY to improve route optimization accuracy.
          </p>
        )}
      </div>

      {incident.status !== "resolved" && (
        <button
          type="button"
          onClick={async () => {
            try {
              await updateIncidentStatus(incident.id, "resolved");
              toast.success("Incident marked as resolved.");
              navigate("/responder", { replace: true });
            } catch (error) {
              toast.error((error as Error).message || "Unable to mark incident as resolved.");
            }
          }}
          className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_30px_-20px_rgba(5,150,105,0.9)]"
        >
          Mark as Resolved
        </button>
      )}

      {isFullscreenMapOpen && destination && mapCenter && typeof document !== "undefined"
        ? createPortal(
        <div className="fixed inset-0 z-[120] bg-black/55 backdrop-blur-[2px] animate-map-overlay">
          <div className="relative h-full w-full animate-map-zoom-in will-change-transform">
            <MapContainer
              center={mapCenter}
              zoom={14}
              scrollWheelZoom
              className="absolute inset-0 h-full w-full"
            >
              <TileLayer
                url={
                  hasGeoapifyKey
                    ? `https://maps.geoapify.com/v1/tile/osm-carto/{z}/{x}/{y}.png?apiKey=${GEOAPIFY_API_KEY}`
                    : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                }
                attribution={
                  hasGeoapifyKey
                    ? "&copy; OpenStreetMap contributors | Tiles by Geoapify"
                    : "&copy; OpenStreetMap contributors"
                }
              />
              {currentPosition ? (
                <Marker position={currentPosition} icon={responderMarkerIcon}>
                  <Popup>Your current location</Popup>
                </Marker>
              ) : null}
              <Marker position={destination} icon={responderMarkerIcon}>
                <Popup>Incident scene</Popup>
              </Marker>
              {showRouteDetails && routeOptions.length > 0
                ? routeOptions.map((route) => {
                    const isSelected = selectedRoute?.id === route.id;
                    const isFastest = fastestRouteId === route.id;

                    return (
                      <Polyline
                        key={route.id}
                        positions={route.points}
                        pathOptions={{
                          color: isSelected ? "#f97316" : isFastest ? "#fb923c" : "#9ca3af",
                          weight: isSelected ? 6 : 4,
                          opacity: isSelected ? 0.95 : isFastest ? 0.65 : 0.4,
                          dashArray: isSelected ? undefined : "6 8",
                        }}
                      />
                    );
                  })
                : null}
              {showRouteDetails && currentPosition ? (
                <RouteViewport
                  points={
                    selectedRoute?.points?.length
                      ? selectedRoute.points
                      : [currentPosition, destination]
                  }
                  followPoint={currentPosition}
                />
              ) : null}
            </MapContainer>
          </div>

          <div className="pointer-events-none absolute inset-0 z-[500]">
            <div className="pointer-events-auto absolute top-4 right-4 flex flex-col items-end gap-2">
              <button
                type="button"
                onClick={() => setIsFullscreenMapOpen(false)}
                className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/85 px-3 py-1.5 text-xs font-semibold text-foreground shadow-lg backdrop-blur-md"
              >
                <ArrowLeft size={14} />
                Back
              </button>
              <button
                type="button"
                onClick={() => {
                  lastRouteKeyRef.current = null;
                  setRouteRefreshToken((current) => current + 1);
                }}
                className="rounded-full border border-white/70 bg-white/85 px-3 py-1.5 text-xs font-semibold text-foreground shadow-lg backdrop-blur-md"
              >
                Recalculate
              </button>
            </div>

            <div className="absolute left-4 right-4 z-[700] pointer-events-auto bottom-[calc(env(safe-area-inset-bottom,0px)+3.1rem)]">
              <div className="rounded-2xl border border-white/60 bg-white/40 p-2 shadow-[0_28px_60px_-38px_rgba(15,23,42,0.9)] backdrop-blur-xl">
                <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-700/80">
                  Route Insights
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-white/70 bg-white/70 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {routeApproximate ? "ETA (Approx)" : "ETA"}
                    </p>
                    <p className="text-sm font-bold text-foreground">
                      {routeLoading ? "Calculating..." : shownDuration !== null ? formatDuration(shownDuration) : "N/A"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/70 bg-white/70 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {routeApproximate ? "Distance (Approx)" : "Distance"}
                    </p>
                    <p className="text-sm font-bold text-foreground">
                      {routeLoading ? "Calculating..." : shownDistance !== null ? formatDistance(shownDistance) : "N/A"}
                    </p>
                  </div>
                </div>
                {nextInstruction && (
                  <div className="mt-2 rounded-xl border border-white/70 bg-white/72 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Next turn</p>
                    <p className="text-xs font-semibold text-foreground">
                      {nextInstruction.text}
                      {nextInstruction.distance !== null ? ` in ${formatDistance(nextInstruction.distance)}` : ""}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

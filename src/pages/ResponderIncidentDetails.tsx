import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  Loader2,
  MapPin,
  Navigation,
  Route,
  TriangleAlert,
} from "lucide-react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer } from "react-leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import { useIncidents } from "@/hooks/useIncidents";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const GEOAPIFY_API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY;

type LatLng = [number, number];

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

  const [routePoints, setRoutePoints] = useState<LatLng[]>([]);
  const [routeDistance, setRouteDistance] = useState<number | null>(null);
  const [routeDuration, setRouteDuration] = useState<number | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const lastRouteKeyRef = useRef<string | null>(null);

  const destination = useMemo(() => {
    if (!incident?.coordinates) return null;
    return [incident.coordinates.lat, incident.coordinates.lng] as LatLng;
  }, [incident?.coordinates?.lat, incident?.coordinates?.lng]);
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
  const shownDistance = routeDistance ?? fallbackDistance;
  const shownDuration = routeDuration ?? fallbackDuration;
  const routeApproximate = routeDistance === null || routeDuration === null;

  useEffect(() => {
    if (!navigator.geolocation) {
      setPositionError("Geolocation is not supported on this device.");
      setLocating(false);
      return;
    }

    setLocating(true);
    setPositionError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCurrentPosition([pos.coords.latitude, pos.coords.longitude]);
        setLocating(false);
      },
      (error) => {
        setPositionError(error.message || "Unable to detect current location.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
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

    const routeKey = `${currentLat},${currentLng}->${destinationLat},${destinationLng}`;
    if (lastRouteKeyRef.current === routeKey) {
      return;
    }

    if (!hasGeoapifyKey) {
      setRouteError("Geoapify key is missing. Showing straight-line fallback route.");
      setRoutePoints([]);
      setRouteDistance(null);
      setRouteDuration(null);
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
        const feature = data?.features?.[0];

        if (!feature) {
          throw new Error("No route was returned by Geoapify.");
        }

        const geometry = feature.geometry;
        const coordinates: LatLng[] = [];

        if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
          geometry.coordinates.forEach((point: [number, number]) => {
            coordinates.push([point[1], point[0]]);
          });
        }

        if (geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
          geometry.coordinates.forEach((segment: [number, number][]) => {
            segment.forEach((point: [number, number]) => {
              coordinates.push([point[1], point[0]]);
            });
          });
        }

        if (!coordinates.length) {
          throw new Error("Route geometry was empty.");
        }

        setRoutePoints(coordinates);
        setRouteDistance(feature.properties?.distance ?? null);
        setRouteDuration(feature.properties?.time ?? null);
        lastRouteKeyRef.current = routeKey;
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setRouteError((error as Error).message || "Unable to compute route.");
          setRoutePoints([]);
          setRouteDistance(null);
          setRouteDuration(null);
          lastRouteKeyRef.current = routeKey;
        } else {
          setRouteError("Routing request timed out. Showing approximate route.");
          setRoutePoints([]);
          setRouteDistance(null);
          setRouteDuration(null);
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
  }, [currentLat, currentLng, destinationLat, destinationLng, hasGeoapifyKey]);

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

  return (
    <div className="pb-8 px-4 pt-4 max-w-lg mx-auto space-y-4 animate-fade-in">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/responder")}
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-foreground">Assigned Incident Details</h1>
      </div>

      <div className="bg-card rounded-xl border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <CategoryIcon category={incident.category} size={20} showLabel />
          <StatusBadge status={incident.status} />
        </div>

        <p className="text-sm text-foreground leading-relaxed">{incident.description}</p>

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
      </div>

      <div className="bg-card rounded-xl border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Route size={16} className="text-info" />
          <h2 className="text-sm font-bold uppercase tracking-wider">Geoapify Route</h2>
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

        {routeLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground animate-slide-up">
            <Loader2 size={16} className="animate-spin" />
            Calculating drive route to scene...
          </div>
        )}

        {routeError && (
          <div className="flex items-start gap-2 text-sm text-destructive animate-slide-up">
            <TriangleAlert size={16} className="mt-0.5" />
            <span>{routeError}</span>
          </div>
        )}

        {!locating && currentPosition && destination && (
          <div className="space-y-3 animate-slide-up">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-secondary px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {routeApproximate ? "Distance (Approx)" : "Distance"}
                </p>
                <p className="text-sm font-semibold text-foreground">
                  {shownDistance !== null ? formatDistance(shownDistance) : "N/A"}
                </p>
              </div>
              <div className="rounded-lg bg-secondary px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {routeApproximate ? "ETA (Approx)" : "ETA"}
                </p>
                <p className="text-sm font-semibold text-foreground">
                  {shownDuration !== null ? formatDuration(shownDuration) : "N/A"}
                </p>
              </div>
            </div>

            <div className="h-72 rounded-xl overflow-hidden border">
              <MapContainer
                center={currentPosition}
                zoom={13}
                scrollWheelZoom
                className="h-full w-full"
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
                <Marker position={currentPosition} icon={responderMarkerIcon}>
                  <Popup>Your current location</Popup>
                </Marker>
                <Marker position={destination} icon={responderMarkerIcon}>
                  <Popup>Incident scene</Popup>
                </Marker>
                <Polyline
                  positions={routePoints.length > 0 ? routePoints : [currentPosition, destination]}
                  pathOptions={{ color: "#0284c7", weight: 5, dashArray: routePoints.length > 0 ? undefined : "6 6" }}
                />
              </MapContainer>
            </div>

            {hasGeoapifyKey ? (
              <a
                href={`https://map.geoapify.com/v1/directions?waypoints=${encodeURIComponent(
                  `${currentPosition[0]},${currentPosition[1]}|${destination[0]},${destination[1]}`
                )}&mode=drive&apiKey=${GEOAPIFY_API_KEY}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 bg-info text-info-foreground rounded-xl px-3 py-2 text-xs font-semibold"
              >
                <Navigation size={14} />
                Open in Geoapify Navigation
              </a>
            ) : (
              <p className="text-xs text-muted-foreground">
                Add VITE_GEOAPIFY_API_KEY to enable turn-by-turn Geoapify navigation links.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

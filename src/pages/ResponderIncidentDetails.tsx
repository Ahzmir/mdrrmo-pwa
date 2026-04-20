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
import { useIncidents } from "@/hooks/useIncidents";
import { acceptIncident, markIncidentOnScene, rejectIncident, updateIncidentStatus } from "@/stores/incidentStore";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { toast } from "sonner";
import { loadGoogleMapsApi } from "@/lib/googleMaps";
import { useAuth } from "@/contexts/AuthContext";

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const ARRIVAL_RADIUS_METERS = 120;
const OFF_ROUTE_REROUTE_METERS = 70;

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
  source: "google";
};

type RoutePolylineLayers = {
  casing: google.maps.Polyline;
  main: google.maps.Polyline;
};

type RouteEtaLabelMarker = {
  marker: google.maps.marker.AdvancedMarkerElement;
  element: HTMLDivElement;
};

type GoogleRoutesApiResponse = {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string;
    polyline?: {
      encodedPolyline?: string;
    };
    legs?: Array<{
      steps?: Array<{
        distanceMeters?: number;
        staticDuration?: string;
        navigationInstruction?: {
          instructions?: string;
        };
      }>;
    }>;
  }>;
};

const ROUTE_OPTIMIZATION_REFRESH_MS = 90000;
const POOR_GPS_ACCURACY_METERS = 80;
const DESTINATION_FLAG_ICON =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'>
      <path d='M10 4v29' stroke='#1f2937' stroke-width='3' stroke-linecap='round'/>
      <path d='M12 7h18l-4 6 4 6H12z' fill='#ef4444' stroke='#b91c1c' stroke-width='1.5'/>
      <circle cx='10' cy='35' r='3.2' fill='#1f2937'/>
    </svg>`
  );

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

function formatCoordinate(value: number) {
  return value.toFixed(6);
}

function getDestinationLabel(locationText: string) {
  const trimmed = locationText.trim();
  if (!trimmed) return "Incident";

  const looksCoordinatePair = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(trimmed);
  if (looksCoordinatePair) {
    return "Incident";
  }

  return trimmed.length > 26 ? `${trimmed.slice(0, 23)}...` : trimmed;
}

function buildExternalGoogleDirectionsUrl(destination: LatLng, currentPosition: LatLng | null) {
  const destinationParam = `${destination[0].toFixed(6)},${destination[1].toFixed(6)}`;

  if (!currentPosition) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destinationParam)}`;
  }

  const originParam = `${currentPosition[0].toFixed(6)},${currentPosition[1].toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originParam)}&destination=${encodeURIComponent(destinationParam)}&travelmode=driving&dir_action=navigate`;
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

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function toGoogleLatLng(point: LatLng): google.maps.LatLngLiteral {
  return { lat: point[0], lng: point[1] };
}

function createResponderRoleMarker(
  rotationDeg: number,
  unit: "police" | "medic" | "disaster" | "default"
) {
  const marker = document.createElement("div");
  marker.style.width = "34px";
  marker.style.height = "34px";
  marker.style.display = "grid";
  marker.style.placeItems = "center";
  marker.style.transform = `rotate(${rotationDeg}deg)`;

  const roleMeta: Record<"police" | "medic" | "disaster" | "default", { color: string; icon: string }> = {
    police: { color: "#1d4ed8", icon: "🛡" },
    medic: { color: "#dc2626", icon: "✚" },
    disaster: { color: "#ea580c", icon: "⚠" },
    default: { color: "#2563eb", icon: "◆" },
  };

  const meta = roleMeta[unit];

  const body = document.createElement("div");
  body.style.width = "26px";
  body.style.height = "26px";
  body.style.borderRadius = "9999px";
  body.style.border = "2px solid #ffffff";
  body.style.background = meta.color;
  body.style.color = "#ffffff";
  body.style.display = "grid";
  body.style.placeItems = "center";
  body.style.fontWeight = "800";
  body.style.fontSize = "13px";
  body.style.lineHeight = "1";
  body.style.boxShadow = "0 10px 20px -12px rgba(15,23,42,0.8)";
  body.style.transform = "rotate(45deg)";
  body.textContent = meta.icon;

  const glyph = document.createElement("span");
  glyph.textContent = meta.icon;
  glyph.style.transform = "rotate(-45deg)";
  glyph.style.display = "inline-block";
  glyph.style.fontSize = unit === "medic" ? "12px" : "13px";

  body.textContent = "";
  body.appendChild(glyph);

  marker.appendChild(body);
  return marker;
}

function createDestinationFlagMarker(label: string) {
  const marker = document.createElement("div");
  marker.style.display = "flex";
  marker.style.alignItems = "center";
  marker.style.gap = "8px";
  marker.style.transform = "translate(-10px, -28px)";

  const icon = document.createElement("img");
  icon.src = DESTINATION_FLAG_ICON;
  icon.alt = "Incident location";
  icon.style.width = "40px";
  icon.style.height = "40px";

  const chip = document.createElement("div");
  chip.textContent = label;
  chip.style.padding = "3px 8px";
  chip.style.borderRadius = "9999px";
  chip.style.background = "rgba(255,255,255,0.92)";
  chip.style.border = "1px solid rgba(148,163,184,0.55)";
  chip.style.color = "#0f172a";
  chip.style.fontSize = "12px";
  chip.style.fontWeight = "700";
  chip.style.whiteSpace = "nowrap";
  chip.style.boxShadow = "0 4px 14px -8px rgba(15,23,42,0.45)";

  marker.appendChild(icon);
  marker.appendChild(chip);
  return marker;
}

function createDestinationPinMarker() {
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.alignItems = "center";
  wrapper.style.transform = "translate(0, -38px)";

  const badge = document.createElement("div");
  badge.textContent = "END";
  badge.style.marginBottom = "6px";
  badge.style.padding = "2px 8px";
  badge.style.borderRadius = "9999px";
  badge.style.background = "rgba(255,255,255,0.96)";
  badge.style.border = "1px solid rgba(220,38,38,0.45)";
  badge.style.color = "#991b1b";
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "800";
  badge.style.letterSpacing = "0.03em";

  const pin = document.createElement("div");
  pin.style.width = "28px";
  pin.style.height = "28px";
  pin.style.borderRadius = "50% 50% 50% 0";
  pin.style.transform = "rotate(-45deg)";
  pin.style.background = "#ef4444";
  pin.style.border = "3px solid #ffffff";
  pin.style.boxShadow = "0 10px 20px -12px rgba(127,29,29,0.9), 0 0 0 3px rgba(220,38,38,0.35)";
  pin.style.position = "relative";

  const center = document.createElement("div");
  center.style.position = "absolute";
  center.style.left = "50%";
  center.style.top = "50%";
  center.style.width = "9px";
  center.style.height = "9px";
  center.style.transform = "translate(-50%, -50%) rotate(45deg)";
  center.style.borderRadius = "9999px";
  center.style.background = "#ffffff";

  pin.appendChild(center);
  wrapper.appendChild(badge);
  wrapper.appendChild(pin);
  return wrapper;
}

function createEndDotMarker() {
  const marker = document.createElement("div");
  marker.style.display = "flex";
  marker.style.flexDirection = "column";
  marker.style.alignItems = "center";
  marker.style.transform = "translate(0, -26px)";

  const text = document.createElement("div");
  text.textContent = "END";
  text.style.color = "#b91c1c";
  text.style.fontSize = "12px";
  text.style.fontWeight = "800";
  text.style.letterSpacing = "0.02em";
  text.style.marginBottom = "5px";
  text.style.padding = "2px 6px";
  text.style.borderRadius = "9999px";
  text.style.background = "rgba(255,255,255,0.95)";
  text.style.border = "1px solid rgba(220,38,38,0.35)";

  const dot = document.createElement("div");
  dot.style.width = "22px";
  dot.style.height = "22px";
  dot.style.borderRadius = "9999px";
  dot.style.background = "radial-gradient(circle at center, #ffffff 0 25%, #ef4444 26% 100%)";
  dot.style.border = "3px solid #ffffff";
  dot.style.boxShadow = "0 0 0 4px rgba(220,38,38,0.35), 0 10px 20px -10px rgba(127,29,29,0.7)";

  marker.appendChild(text);
  marker.appendChild(dot);
  return marker;
}

function createRouteEtaMarker(durationSeconds: number | null, isSelected: boolean) {
  const marker = document.createElement("div");
  marker.style.padding = "5px 9px";
  marker.style.borderRadius = "9999px";
  marker.style.fontSize = "12px";
  marker.style.fontWeight = "700";
  marker.style.whiteSpace = "nowrap";
  marker.style.border = isSelected ? "1px solid rgba(147,51,234,0.75)" : "1px solid rgba(148,163,184,0.6)";
  marker.style.background = isSelected ? "rgba(219,234,254,0.96)" : "rgba(255,255,255,0.92)";
  marker.style.color = "#0f172a";
  marker.style.boxShadow = "0 8px 16px -10px rgba(15,23,42,0.45)";
  marker.style.transform = "translate(-50%, -50%)";
  marker.textContent = durationSeconds !== null ? formatDuration(durationSeconds) : "N/A";
  return marker;
}

function getRouteBadgePoint(points: LatLng[], routeIndex: number, routeCount: number) {
  if (!points.length) {
    return null;
  }

  // Spread route labels along each polyline to reduce overlap in dense grids.
  const baseFraction = 0.34;
  const step = routeCount > 1 ? 0.34 / (routeCount - 1) : 0;
  const fraction = Math.min(0.8, baseFraction + routeIndex * step);
  const index = Math.max(0, Math.min(points.length - 1, Math.round((points.length - 1) * fraction)));
  return points[index];
}

function getRouteBadgeTransform(routeIndex: number) {
  const offsets = [
    { x: 0, y: -8 },
    { x: 36, y: -22 },
    { x: -34, y: 14 },
    { x: 24, y: 18 },
    { x: -24, y: -24 },
  ];
  const offset = offsets[routeIndex % offsets.length];
  return `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`;
}

function buildBounds(points: LatLng[]) {
  const bounds = new google.maps.LatLngBounds();
  points.forEach((point) => {
    bounds.extend({ lat: point[0], lng: point[1] });
  });
  return bounds;
}

function getBearingDegrees(from: LatLng, to: LatLng) {
  const lat1 = (from[0] * Math.PI) / 180;
  const lat2 = (to[0] * Math.PI) / 180;
  const dLng = ((to[1] - from[1]) * Math.PI) / 180;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const theta = Math.atan2(y, x);
  return (theta * 180) / Math.PI + 360;
}

function normalizeHeading(heading: number) {
  return ((heading % 360) + 360) % 360;
}

function smoothHeading(previous: number, next: number) {
  const prev = normalizeHeading(previous);
  const target = normalizeHeading(next);
  let delta = target - prev;

  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;

  return normalizeHeading(prev + delta * 0.35);
}

function distanceToSegmentMeters(point: LatLng, start: LatLng, end: LatLng) {
  const latScale = 111320;
  const midLatRad = ((start[0] + end[0]) / 2) * (Math.PI / 180);
  const lngScale = 111320 * Math.cos(midLatRad);

  const px = point[1] * lngScale;
  const py = point[0] * latScale;
  const sx = start[1] * lngScale;
  const sy = start[0] * latScale;
  const ex = end[1] * lngScale;
  const ey = end[0] * latScale;

  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.sqrt((px - sx) * (px - sx) + (py - sy) * (py - sy));
  }

  const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSquared));
  const cx = sx + t * dx;
  const cy = sy + t * dy;

  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

function distanceToPolylineMeters(point: LatLng, polyline: LatLng[]) {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return haversineMeters(point, polyline[0]);

  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const distance = distanceToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  return minDistance;
}

function ResponderIncidentGoogleMap({
  mapCenter,
  currentPosition,
  currentHeading,
  currentSpeedMps,
  destination,
  destinationLabel,
  routeOptions,
  selectedRouteId,
  fastestRouteId,
  showRouteDetails,
  className,
  zoom,
  isFullscreen,
  onRouteSelect,
  focusDestinationToken,
  responderUnit,
}: {
  mapCenter: LatLng;
  currentPosition: LatLng | null;
  currentHeading: number | null;
  currentSpeedMps: number | null;
  destination: LatLng;
  destinationLabel: string;
  routeOptions: RouteOption[];
  selectedRouteId: string | null;
  fastestRouteId: string | null;
  showRouteDetails: boolean;
  className: string;
  zoom: number;
  isFullscreen: boolean;
  onRouteSelect: (routeId: string) => void;
  focusDestinationToken: number;
  responderUnit: "police" | "medic" | "disaster" | "default";
}) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [mapReadyTick, setMapReadyTick] = useState(0);
  const responderMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const destinationMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const destinationLegacyMarkerRef = useRef<google.maps.Marker | null>(null);
  const destinationLabelMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const destinationRingRef = useRef<google.maps.Circle | null>(null);
  const routePolylineByIdRef = useRef<Map<string, RoutePolylineLayers>>(new Map());
  const routeEtaMarkerByIdRef = useRef<Map<string, RouteEtaLabelMarker>>(new Map());
  const sharedInfoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const hasIntroAnimatedRef = useRef(false);
  const lastFollowAnimationAtRef = useRef(0);
  const hasInitializedOverviewCameraRef = useRef(false);
  const previousShowRouteDetailsRef = useRef(showRouteDetails);
  const lastHandledFocusDestinationTokenRef = useRef(0);
  const lastResponderPointRef = useRef<LatLng | null>(null);
  const lastHeadingRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    void loadGoogleMapsApi()
      .then(() => {
        if (cancelled || !mapElementRef.current) {
          return;
        }

        const map = new google.maps.Map(mapElementRef.current, {
          center: toGoogleLatLng(mapCenter),
          zoom,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          rotateControl: true,
          tilt: 0,
          clickableIcons: false,
          gestureHandling: "greedy",
          mapId: import.meta.env.VITE_GOOGLE_MAP_ID || "DEMO_MAP_ID",
        });

        mapRef.current = map;
        setMapReadyTick((value) => value + 1);
        sharedInfoWindowRef.current = new google.maps.InfoWindow();
      })
      .catch(() => {
        // Parent handles user-visible key/config errors.
      });

    return () => {
      cancelled = true;
      if (responderMarkerRef.current) {
        responderMarkerRef.current.map = null;
      }
      if (destinationMarkerRef.current) {
        destinationMarkerRef.current.map = null;
      }
      destinationLegacyMarkerRef.current?.setMap(null);
      if (destinationLabelMarkerRef.current) {
        destinationLabelMarkerRef.current.map = null;
      }
      destinationRingRef.current?.setMap(null);
      routePolylineByIdRef.current.forEach((layers) => {
        layers.main.setMap(null);
        layers.casing.setMap(null);
      });
      routePolylineByIdRef.current.clear();
      routeEtaMarkerByIdRef.current.forEach((entry) => {
        entry.marker.map = null;
      });
      routeEtaMarkerByIdRef.current.clear();
      sharedInfoWindowRef.current?.close();
      sharedInfoWindowRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      google.maps.event.trigger(map, "resize");
    });

    if (mapElementRef.current) {
      resizeObserver.observe(mapElementRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const switchedFromRouteToOverview =
      previousShowRouteDetailsRef.current === true && showRouteDetails === false;

    if (!showRouteDetails) {
      // Keep user-controlled zoom while panning in overview mode.
      // Auto-frame only once on initial load or when leaving route mode.
      if (!hasInitializedOverviewCameraRef.current || switchedFromRouteToOverview) {
        map.setZoom(zoom);
        map.panTo(toGoogleLatLng(mapCenter));
        hasInitializedOverviewCameraRef.current = true;
      }
    }

    previousShowRouteDetailsRef.current = showRouteDetails;
  }, [mapCenter, showRouteDetails, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (showRouteDetails) {
      map.setTilt(45);
      return;
    }

    map.setTilt(0);
    map.setHeading(0);
  }, [showRouteDetails]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const AdvancedMarkerElement = google.maps.marker?.AdvancedMarkerElement;
    const pinContent = createDestinationPinMarker();

    if (AdvancedMarkerElement) {
      destinationLegacyMarkerRef.current?.setMap(null);
      destinationLegacyMarkerRef.current = null;

      if (!destinationMarkerRef.current) {
        destinationMarkerRef.current = new AdvancedMarkerElement({
          map,
          position: toGoogleLatLng(destination),
          content: pinContent,
          zIndex: 3200,
        });

        destinationMarkerRef.current.addEventListener("gmp-click", () => {
          if (!sharedInfoWindowRef.current || !destinationMarkerRef.current) return;
          sharedInfoWindowRef.current.setContent("<div style='font-size:12px;font-weight:600'>Incident scene</div>");
          sharedInfoWindowRef.current.setPosition(destinationMarkerRef.current.position as google.maps.LatLngLiteral);
          sharedInfoWindowRef.current.open({ map });
        });
      }

      destinationMarkerRef.current.position = toGoogleLatLng(destination);
      destinationMarkerRef.current.content = pinContent;
      destinationMarkerRef.current.zIndex = 3200;
    } else {
      if (destinationMarkerRef.current) {
        destinationMarkerRef.current.map = null;
        destinationMarkerRef.current = null;
      }

      if (!destinationLegacyMarkerRef.current) {
        destinationLegacyMarkerRef.current = new google.maps.Marker({
          map,
          position: toGoogleLatLng(destination),
          title: "Incident scene",
          zIndex: 3200,
        });

        destinationLegacyMarkerRef.current.addListener("click", () => {
          if (!sharedInfoWindowRef.current || !destinationLegacyMarkerRef.current) return;
          sharedInfoWindowRef.current.setContent("<div style='font-size:12px;font-weight:600'>Incident scene</div>");
          const markerPosition = destinationLegacyMarkerRef.current.getPosition();
          if (markerPosition) {
            sharedInfoWindowRef.current.setPosition(markerPosition);
          }
          sharedInfoWindowRef.current.open({ map, anchor: destinationLegacyMarkerRef.current });
        });
      }

      destinationLegacyMarkerRef.current.setPosition(toGoogleLatLng(destination));
      destinationLegacyMarkerRef.current.setZIndex(3200);
    }

    if (destinationLabelMarkerRef.current) {
      destinationLabelMarkerRef.current.map = null;
      destinationLabelMarkerRef.current = null;
    }

    if (!destinationRingRef.current) {
      destinationRingRef.current = new google.maps.Circle({
        map,
        center: toGoogleLatLng(destination),
        radius: 42,
        strokeColor: "#dc2626",
        strokeOpacity: 0.96,
        strokeWeight: 3,
        fillColor: "#fecaca",
        fillOpacity: 0.26,
        zIndex: 2400,
      });
    }

    destinationRingRef.current?.setCenter(toGoogleLatLng(destination));
  }, [destination, destinationLabel, mapReadyTick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (!currentPosition) {
      if (responderMarkerRef.current) {
        responderMarkerRef.current.map = null;
      }
      responderMarkerRef.current = null;
      return;
    }

    const AdvancedMarkerElement = google.maps.marker?.AdvancedMarkerElement;
    if (!AdvancedMarkerElement) {
      return;
    }

    if (!responderMarkerRef.current) {
      responderMarkerRef.current = new AdvancedMarkerElement({
        map,
        position: toGoogleLatLng(currentPosition),
        content: createResponderRoleMarker(lastHeadingRef.current, responderUnit),
        zIndex: 180,
      });

      responderMarkerRef.current.addEventListener("gmp-click", () => {
        if (!sharedInfoWindowRef.current || !responderMarkerRef.current) return;
        sharedInfoWindowRef.current.setContent("<div style='font-size:12px;font-weight:600'>Your current location</div>");
        sharedInfoWindowRef.current.setPosition(responderMarkerRef.current.position as google.maps.LatLngLiteral);
        sharedInfoWindowRef.current.open({ map });
      });
    }

    const hasReliableSensorHeading =
      currentHeading !== null &&
      Number.isFinite(currentHeading) &&
      (currentSpeedMps === null || currentSpeedMps > 0.8);

    const previousPoint = lastResponderPointRef.current;
    if (previousPoint || hasReliableSensorHeading) {
      const rawHeading = hasReliableSensorHeading
        ? currentHeading
        : getBearingDegrees(previousPoint || currentPosition, currentPosition);
      const nextHeading = smoothHeading(lastHeadingRef.current, rawHeading ?? lastHeadingRef.current);
      lastHeadingRef.current = nextHeading;
      responderMarkerRef.current.content = createResponderRoleMarker(nextHeading, responderUnit);

      if (showRouteDetails) {
        map.setHeading(nextHeading);
      }
    }

    responderMarkerRef.current.position = toGoogleLatLng(currentPosition);
    lastResponderPointRef.current = currentPosition;
  }, [currentHeading, currentPosition, currentSpeedMps, responderUnit, showRouteDetails]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const AdvancedMarkerElement = google.maps.marker?.AdvancedMarkerElement;
    if (!AdvancedMarkerElement) {
      return;
    }

    const activeRouteIds = new Set<string>();

    if (showRouteDetails && routeOptions.length > 0) {
      routeOptions.forEach((route, routeIndex) => {
        activeRouteIds.add(route.id);

        const isSelected = selectedRouteId ? selectedRouteId === route.id : routeOptions[0]?.id === route.id;
        const isFastest = fastestRouteId === route.id;
        const casingColor = isSelected ? "#1e1b7a" : isFastest ? "#3b82f6" : "#60a5fa";
        const mainColor = isSelected ? "#2563eb" : isFastest ? "#60a5fa" : "#93c5fd";
        const casingWeight = isSelected ? 11 : isFastest ? 8 : 7;
        const mainWeight = isSelected ? 7 : isFastest ? 5 : 4;
        const casingOpacity = isSelected ? 0.92 : isFastest ? 0.72 : 0.6;
        const mainOpacity = isSelected ? 0.98 : isFastest ? 0.9 : 0.78;

        const existingLayers = routePolylineByIdRef.current.get(route.id);
        if (!existingLayers) {
          const casing = new google.maps.Polyline({
            map,
            path: route.points.map(toGoogleLatLng),
            strokeColor: casingColor,
            strokeOpacity: casingOpacity,
            strokeWeight: casingWeight,
            zIndex: isSelected ? 125 : isFastest ? 105 : 85,
          });

          const main = new google.maps.Polyline({
            map,
            path: route.points.map(toGoogleLatLng),
            strokeColor: mainColor,
            strokeOpacity: mainOpacity,
            strokeWeight: mainWeight,
            zIndex: isSelected ? 130 : isFastest ? 110 : 90,
          });

          routePolylineByIdRef.current.set(route.id, { casing, main });
          return;
        }

        existingLayers.casing.setOptions({
          path: route.points.map(toGoogleLatLng),
          strokeColor: casingColor,
          strokeOpacity: casingOpacity,
          strokeWeight: casingWeight,
          zIndex: isSelected ? 125 : isFastest ? 105 : 85,
        });

        existingLayers.main.setOptions({
          path: route.points.map(toGoogleLatLng),
          strokeColor: mainColor,
          strokeOpacity: mainOpacity,
          strokeWeight: mainWeight,
          zIndex: isSelected ? 130 : isFastest ? 110 : 90,
        });

        const badgePoint = getRouteBadgePoint(route.points, routeIndex, routeOptions.length) || route.points[0];
        const existingEta = routeEtaMarkerByIdRef.current.get(route.id);
        if (!existingEta) {
          const element = createRouteEtaMarker(route.duration, isSelected);
          element.style.transform = getRouteBadgeTransform(routeIndex);
          const marker = new AdvancedMarkerElement({
            map,
            position: toGoogleLatLng(badgePoint),
            content: element,
            zIndex: isSelected ? 220 : 170,
          });
          marker.addEventListener("gmp-click", () => {
            onRouteSelect(route.id);
            const bounds = buildBounds(route.points);
            map.fitBounds(bounds, isFullscreen ? { top: 100, right: 84, bottom: 280, left: 84 } : 72);
          });
          routeEtaMarkerByIdRef.current.set(route.id, { marker, element });
        } else {
          existingEta.marker.position = toGoogleLatLng(badgePoint);
          existingEta.marker.zIndex = isSelected ? 220 : 170;
          existingEta.element.textContent = route.duration !== null ? formatDuration(route.duration) : "N/A";
          existingEta.element.style.transform = getRouteBadgeTransform(routeIndex);
          existingEta.element.style.border = isSelected
            ? "1px solid rgba(147,51,234,0.75)"
            : "1px solid rgba(148,163,184,0.6)";
          existingEta.element.style.background = isSelected
            ? "rgba(219,234,254,0.96)"
            : "rgba(255,255,255,0.92)";
        }
      });
    }

    routePolylineByIdRef.current.forEach((layers, id) => {
      if (activeRouteIds.has(id)) {
        return;
      }

      layers.casing.setMap(null);
      layers.main.setMap(null);
      routePolylineByIdRef.current.delete(id);
    });

    routeEtaMarkerByIdRef.current.forEach((entry, id) => {
      if (activeRouteIds.has(id)) {
        return;
      }

      entry.marker.map = null;
      routeEtaMarkerByIdRef.current.delete(id);
    });
  }, [fastestRouteId, routeOptions, selectedRouteId, showRouteDetails]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showRouteDetails || !currentPosition) {
      return;
    }

    const selectedRoute = routeOptions.find((option) => option.id === selectedRouteId) || routeOptions[0];
    if (!selectedRoute || selectedRoute.points.length < 2) {
      return;
    }

    const bounds = buildBounds(selectedRoute.points);

    if (!hasIntroAnimatedRef.current) {
      map.fitBounds(bounds, isFullscreen ? { top: 94, right: 84, bottom: 280, left: 84 } : 72);
      hasIntroAnimatedRef.current = true;
      return;
    }

    const now = Date.now();
    if (now - lastFollowAnimationAtRef.current < 2200) {
      return;
    }

    lastFollowAnimationAtRef.current = now;
    const followBounds = buildBounds([currentPosition, destination]);
    map.fitBounds(
      followBounds,
      isFullscreen
        ? { top: 96, right: 84, bottom: 290, left: 84 }
        : { top: 84, right: 84, bottom: 120, left: 84 }
    );
    if ((map.getZoom() || 13) > 16) {
      map.setZoom(16);
    }
  }, [currentPosition, destination, isFullscreen, routeOptions, selectedRouteId, showRouteDetails]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (focusDestinationToken <= 0) {
      return;
    }

    if (lastHandledFocusDestinationTokenRef.current === focusDestinationToken) {
      return;
    }

    lastHandledFocusDestinationTokenRef.current = focusDestinationToken;

    if (currentPosition) {
      const bounds = buildBounds([currentPosition, destination]);
      map.fitBounds(
        bounds,
        isFullscreen
          ? { top: 96, right: 84, bottom: 290, left: 84 }
          : { top: 84, right: 84, bottom: 120, left: 84 }
      );
      if ((map.getZoom() || 13) > 17) {
        map.setZoom(17);
      }
      return;
    }

    map.panTo(toGoogleLatLng(destination));
    map.setZoom(Math.max(map.getZoom() || 13, 17));
  }, [currentPosition, destination, focusDestinationToken, isFullscreen]);

  return <div ref={mapElementRef} className={className} />;
}

export default function ResponderIncidentDetails() {
  const navigate = useNavigate();
  const { incidentId } = useParams<{ incidentId: string }>();
  const incidents = useIncidents();
  const { user } = useAuth();

  const incident = useMemo(
    () => incidents.find((i) => i.id === incidentId),
    [incidents, incidentId]
  );

  const [currentPosition, setCurrentPosition] = useState<LatLng | null>(null);
  const [currentHeading, setCurrentHeading] = useState<number | null>(null);
  const [currentSpeedMps, setCurrentSpeedMps] = useState<number | null>(null);
  const [currentAccuracyM, setCurrentAccuracyM] = useState<number | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [locating, setLocating] = useState(true);

  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [showRouteDetails, setShowRouteDetails] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeRefreshToken, setRouteRefreshToken] = useState(0);
  const lastRouteKeyRef = useRef<string | null>(null);
  const lastOffRouteRerouteAtRef = useRef(0);
  const [acceptedLocally, setAcceptedLocally] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [isFullscreenMapOpen, setIsFullscreenMapOpen] = useState(false);
  const [focusDestinationToken, setFocusDestinationToken] = useState(0);
  const autoOnSceneInFlightRef = useRef(false);

  const destination = useMemo(() => {
    if (!incident?.coordinates) return null;
    return [incident.coordinates.lat, incident.coordinates.lng] as LatLng;
  }, [incident?.coordinates?.lat, incident?.coordinates?.lng]);
  const awaitingDecision = incident?.responderAssignmentStatus === "assigned";
  const hasGoogleMapsKey = typeof GOOGLE_MAPS_API_KEY === "string" && GOOGLE_MAPS_API_KEY.trim().length > 0;
  const currentLat = currentPosition?.[0] ?? null;
  const currentLng = currentPosition?.[1] ?? null;
  const destinationLat = destination?.[0] ?? null;
  const destinationLng = destination?.[1] ?? null;
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

  const shownDistance = selectedRoute?.distance ?? null;
  const shownDuration = selectedRoute?.duration ?? null;
  const selectedRouteInstructions = selectedRoute?.instructions ?? [];
  const nextInstruction = selectedRouteInstructions[0] ?? null;
  const destinationLabel = getDestinationLabel(incident?.location || "");
  const responderUnit =
    user?.responderUnit === "police" || user?.responderUnit === "medic" || user?.responderUnit === "disaster"
      ? user.responderUnit
      : "default";

  useEffect(() => {
    setShowRouteDetails(false);
    setAcceptedLocally(false);
    setDeclineOpen(false);
    setDeclineReason("");
    setIsFullscreenMapOpen(false);
    setFocusDestinationToken(0);
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
        const heading =
          typeof pos.coords.heading === "number" && Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0
            ? pos.coords.heading
            : null;
        const speed =
          typeof pos.coords.speed === "number" && Number.isFinite(pos.coords.speed) && pos.coords.speed >= 0
            ? pos.coords.speed
            : null;
        const accuracy =
          typeof pos.coords.accuracy === "number" && Number.isFinite(pos.coords.accuracy) && pos.coords.accuracy >= 0
            ? pos.coords.accuracy
            : null;
        setCurrentHeading(heading);
        setCurrentSpeedMps(speed);
        setCurrentAccuracyM(accuracy);
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
    if (!showRouteDetails) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRouteRefreshToken((current) => current + 1);
    }, ROUTE_OPTIMIZATION_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [showRouteDetails]);

  useEffect(() => {
    if (!showRouteDetails || !currentPosition || !selectedRoute || selectedRoute.points.length < 2) {
      return;
    }

    const distanceFromRoute = distanceToPolylineMeters(currentPosition, selectedRoute.points);
    if (!Number.isFinite(distanceFromRoute) || distanceFromRoute < OFF_ROUTE_REROUTE_METERS) {
      return;
    }

    const now = Date.now();
    if (now - lastOffRouteRerouteAtRef.current < 15000) {
      return;
    }

    lastOffRouteRerouteAtRef.current = now;
    lastRouteKeyRef.current = null;
    setRouteRefreshToken((current) => current + 1);
  }, [currentPosition, selectedRoute, showRouteDetails]);

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

    if (!hasGoogleMapsKey) {
      setRouteError("Google Maps key is missing.");
      setRouteOptions([]);
      setSelectedRouteId(null);
      lastRouteKeyRef.current = routeKey;
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setRouteError("Routing request timed out.");
      setRouteOptions([]);
      setSelectedRouteId(null);
      setRouteLoading(false);
      lastRouteKeyRef.current = routeKey;
      cancelled = true;
    }, 12000);

    async function fetchRoute() {
      try {
        setRouteLoading(true);
        setRouteError(null);

        await loadGoogleMapsApi();
        if (cancelled) {
          return;
        }

        const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
            "X-Goog-FieldMask": [
              "routes.distanceMeters",
              "routes.duration",
              "routes.polyline.encodedPolyline",
              "routes.legs.steps.distanceMeters",
              "routes.legs.steps.staticDuration",
              "routes.legs.steps.navigationInstruction.instructions",
            ].join(","),
          },
          body: JSON.stringify({
            origin: {
              location: {
                latLng: {
                  latitude: currentLat,
                  longitude: currentLng,
                },
              },
            },
            destination: {
              location: {
                latLng: {
                  latitude: destinationLat,
                  longitude: destinationLng,
                },
              },
            },
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_AWARE_OPTIMAL",
            computeAlternativeRoutes: true,
            languageCode: "en-US",
            units: "METRIC",
            regionCode: "PH",
          }),
        });

        if (!response.ok) {
          throw new Error(`Google Routes API failed (${response.status}).`);
        }

        const result = (await response.json()) as GoogleRoutesApiResponse;

        if (cancelled) {
          return;
        }

        const parsedRoutes: RouteOption[] = (result.routes || [])
          .map((route, index) => {
            const encodedPolyline = route.polyline?.encodedPolyline;
            const points = encodedPolyline ? decodePolyline(encodedPolyline) : [];
            const leg = route.legs?.[0];

            const instructions: RouteInstruction[] = (leg?.steps || []).map((step, stepIndex) => {
              const rawText = step.navigationInstruction?.instructions || "";
              const text = normalizeInstructionText(stripHtml(rawText)) || "Continue";
              return {
                id: `google-${index}-step-${stepIndex}`,
                text,
                distance: toNullableNumber(step.distanceMeters),
                duration: parseDurationSeconds(step.staticDuration),
              };
            });

            return {
              id: `google-${index}`,
              points,
              distance: toNullableNumber(route.distanceMeters),
              duration: parseDurationSeconds(route.duration),
              instructions,
              source: "google",
            };
          })
          .filter((route) => route.points.length > 0);

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
        if (cancelled) {
          return;
        }

        setRouteError((error as Error).message || "Unable to compute route.");
        setRouteOptions([]);
        setSelectedRouteId(null);
        lastRouteKeyRef.current = routeKey;
      } finally {
        window.clearTimeout(timeoutId);
        if (!cancelled) {
          setRouteLoading(false);
        }
      }
    }

    void fetchRoute();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    currentLat,
    currentLng,
    destinationLat,
    destinationLng,
    hasGoogleMapsKey,
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
  const externalGoogleDirectionsUrl = destination
    ? buildExternalGoogleDirectionsUrl(destination, currentPosition)
    : null;

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
              if (!hasGoogleMapsKey) {
                if (!destination) {
                  toast.error("Incident coordinates are unavailable.");
                  return;
                }

                const externalUrl = buildExternalGoogleDirectionsUrl(destination, currentPosition);
                if (typeof window !== "undefined") {
                  window.location.assign(externalUrl);
                }
                toast.info("Google Maps key is missing in this deployment. Opening Google Maps navigation.");
                return;
              }

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

        {routeLoading && showRouteDetails && routeOptions.length === 0 && (
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
                Google optimized routes update live as you move.
              </p>
              <div className="flex items-center gap-2">
                {externalGoogleDirectionsUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        window.location.assign(externalGoogleDirectionsUrl);
                      }
                    }}
                    className="rounded-lg border border-orange-300/80 bg-orange-100/85 px-2.5 py-1 text-[11px] font-semibold text-orange-800 hover:bg-orange-100"
                  >
                    Open Google Nav
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFocusDestinationToken((current) => current + 1)}
                  className="rounded-lg border border-red-300/75 bg-red-100/80 px-2.5 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-100"
                >
                  Focus End
                </button>
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
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Start</p>
                <p className="text-xs font-semibold text-foreground">You are here</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatCoordinate(currentPosition[0])}, {formatCoordinate(currentPosition[1])}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">End</p>
                <p className="text-xs font-semibold text-foreground">Incident ({destinationLabel})</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatCoordinate(destination[0])}, {formatCoordinate(destination[1])}
                </p>
              </div>
            </div>

            {currentAccuracyM !== null && currentAccuracyM > POOR_GPS_ACCURACY_METERS ? (
              <div className="rounded-xl border border-amber-300/80 bg-amber-100/65 px-3 py-2 text-xs text-amber-900">
                GPS accuracy is currently low (~{Math.round(currentAccuracyM)}m). Route origin may drift until signal improves.
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-white/60 bg-white/70 px-3 py-2 backdrop-blur-sm">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Distance</p>
                <p className="text-sm font-semibold text-foreground">
                  {shownDistance !== null ? formatDistance(shownDistance) : "N/A"}
                </p>
              </div>
              <div className="rounded-lg border border-white/60 bg-white/70 px-3 py-2 backdrop-blur-sm">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">ETA</p>
                <p className="text-sm font-semibold text-foreground">
                  {shownDuration !== null ? formatDuration(shownDuration) : "N/A"}
                </p>
              </div>
            </div>

            {routeOptions.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Google route optimization</p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {routeOptions.map((route, index) => {
                    const isSelected = selectedRoute?.id === route.id;
                    const isFastest = fastestRouteId === route.id;

                    return (
                      <button
                        key={route.id}
                        type="button"
                        onClick={() => setSelectedRouteId(route.id)}
                        className={[
                          "min-w-[158px] rounded-full border px-3 py-2 text-left transition-colors",
                          isSelected
                            ? "border-orange-300 bg-orange-100/80 shadow-sm"
                            : "border-white/60 bg-white/70 hover:bg-white/80",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold text-foreground">
                            {isFastest ? "Best Route" : `Alt ${index + 1}`}
                          </p>
                          <p className="text-[11px] font-bold text-foreground">
                            {route.duration !== null ? formatDuration(route.duration) : "N/A"}
                          </p>
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
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

        {destination && mapCenter && hasGoogleMapsKey ? (
          <div className="h-72 overflow-hidden rounded-xl border border-white/60 bg-white/65 backdrop-blur-sm">
            <ResponderIncidentGoogleMap
              mapCenter={mapCenter}
              currentPosition={currentPosition}
              currentHeading={currentHeading}
              currentSpeedMps={currentSpeedMps}
              destination={destination}
              destinationLabel={destinationLabel}
              routeOptions={routeOptions}
              selectedRouteId={selectedRouteId}
              fastestRouteId={fastestRouteId}
              showRouteDetails={showRouteDetails}
              zoom={13}
              isFullscreen={false}
              onRouteSelect={setSelectedRouteId}
              focusDestinationToken={focusDestinationToken}
              responderUnit={responderUnit}
              className="h-full w-full"
            />
          </div>
        ) : destination && mapCenter ? (
          <p className="text-xs text-muted-foreground">
            Add VITE_GOOGLE_MAPS_API_KEY to enable Google Maps rendering.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Incident coordinates are unavailable.</p>
        )}

        {!showRouteDetails && canGetDirections && (
          <p className="text-xs text-muted-foreground">
            Tap <span className="font-semibold text-foreground">Get Directions</span> to reveal ETA and fastest route options.
          </p>
        )}

        {!hasGoogleMapsKey && showRouteDetails && (
          <p className="text-xs text-muted-foreground">
            Add VITE_GOOGLE_MAPS_API_KEY to enable route alternatives.
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

      {isFullscreenMapOpen && destination && mapCenter && hasGoogleMapsKey && typeof document !== "undefined"
        ? createPortal(
        <div className="fixed inset-0 z-[120] bg-black/55 backdrop-blur-[2px] animate-map-overlay">
          <div className="relative h-full w-full animate-map-zoom-in will-change-transform">
            <ResponderIncidentGoogleMap
              mapCenter={mapCenter}
              currentPosition={currentPosition}
              currentHeading={currentHeading}
              currentSpeedMps={currentSpeedMps}
              destination={destination}
              destinationLabel={destinationLabel}
              routeOptions={routeOptions}
              selectedRouteId={selectedRouteId}
              fastestRouteId={fastestRouteId}
              showRouteDetails={showRouteDetails}
              zoom={14}
              isFullscreen={true}
              onRouteSelect={setSelectedRouteId}
              focusDestinationToken={focusDestinationToken}
              responderUnit={responderUnit}
              className="absolute inset-0 h-full w-full"
            />
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
              {externalGoogleDirectionsUrl && (
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      window.location.assign(externalGoogleDirectionsUrl);
                    }
                  }}
                  className="rounded-full border border-orange-300/80 bg-orange-100/90 px-3 py-1.5 text-xs font-semibold text-orange-800 shadow-lg backdrop-blur-md"
                >
                  Open Google Nav
                </button>
              )}
              <button
                type="button"
                onClick={() => setFocusDestinationToken((current) => current + 1)}
                className="rounded-full border border-red-300/80 bg-red-100/90 px-3 py-1.5 text-xs font-semibold text-red-800 shadow-lg backdrop-blur-md"
              >
                Focus End
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
                {routeOptions.length > 0 && (
                  <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1">
                    {routeOptions.map((route, index) => {
                      const isSelected = selectedRoute?.id === route.id;
                      const isFastest = fastestRouteId === route.id;
                      return (
                        <button
                          key={`fullscreen-${route.id}`}
                          type="button"
                          onClick={() => setSelectedRouteId(route.id)}
                          className={[
                            "rounded-full border px-3 py-1 text-[11px] font-semibold whitespace-nowrap",
                            isSelected
                              ? "border-orange-300 bg-orange-100/90 text-foreground"
                              : "border-white/70 bg-white/78 text-muted-foreground",
                          ].join(" ")}
                        >
                          {isFastest ? "Best" : `Alt ${index + 1}`}: {route.duration !== null ? formatDuration(route.duration) : "N/A"}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-white/70 bg-white/70 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">ETA</p>
                    <p className="text-sm font-bold text-foreground">
                      {shownDuration !== null ? formatDuration(shownDuration) : "N/A"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/70 bg-white/70 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Distance</p>
                    <p className="text-sm font-bold text-foreground">
                      {shownDistance !== null ? formatDistance(shownDistance) : "N/A"}
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

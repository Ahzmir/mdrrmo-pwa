import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronUp, Inbox, MapPin, Route } from "lucide-react";
import { useReports } from "@/hooks/useReports";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { db } from "@/lib/firebase";
import { Timestamp, doc, onSnapshot } from "firebase/firestore";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer } from "react-leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

type ResponderLiveRow = {
  uid: string;
  lat: number;
  lng: number;
  updatedAt: Date | null;
};

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
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [responderLiveRows, setResponderLiveRows] = useState<ResponderLiveRow[]>([]);

  const expandedReport = useMemo(
    () => reports.find((report) => report.id === expandedReportId) || null,
    [expandedReportId, reports]
  );

  useEffect(() => {
    const assigned = expandedReport?.assignedResponders || [];
    if (!expandedReport || assigned.length === 0) {
      setResponderLiveRows([]);
      return;
    }

    const liveByUid = new Map<string, ResponderLiveRow>();
    const unsubs = assigned.map((uid) =>
      onSnapshot(
        doc(db, "responderLiveLocations", uid),
        (snapshot) => {
          if (!snapshot.exists()) {
            liveByUid.delete(uid);
            setResponderLiveRows(Array.from(liveByUid.values()));
            return;
          }

          const data = snapshot.data() as Record<string, unknown>;
          const coord = toLiveCoordinate(data.liveLocation);
          if (!coord) {
            liveByUid.delete(uid);
            setResponderLiveRows(Array.from(liveByUid.values()));
            return;
          }

          liveByUid.set(uid, {
            uid,
            lat: coord.lat,
            lng: coord.lng,
            updatedAt: toDate(data.liveLocationUpdatedAt),
          });
          setResponderLiveRows(Array.from(liveByUid.values()));
        },
        () => {
          liveByUid.delete(uid);
          setResponderLiveRows(Array.from(liveByUid.values()));
        }
      )
    );

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [expandedReport]);

  return (
    <div className="pb-24 px-4 pt-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="p-1 text-muted-foreground">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-foreground">My Reports</h1>
      </div>

      {reports.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
            <Inbox size={28} className="text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            No reports yet. Tap "Report Incident" to submit one.
          </p>
          <button
            onClick={() => navigate("/report")}
            className="mt-2 bg-emergency text-emergency-foreground rounded-xl px-6 py-3 font-semibold text-sm"
          >
            Report Now
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => (
            <div
              key={r.id}
              className="bg-card rounded-xl p-4 border space-y-2"
            >
              <div className="flex items-center justify-between">
                <CategoryIcon category={r.category} size={18} showLabel />
                <StatusBadge status={r.status} />
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

              <button
                onClick={() => setExpandedReportId((current) => (current === r.id ? null : r.id))}
                className="mt-1 flex w-full items-center justify-between rounded-lg border bg-secondary/30 px-3 py-2 text-xs font-semibold text-foreground"
              >
                <span>View details and responder route</span>
                {expandedReportId === r.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {expandedReportId === r.id && (
                <div className="space-y-3 rounded-lg border bg-background p-3">
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                    <p>Report ID: <span className="font-semibold text-foreground">{r.id}</span></p>
                    <p>Assigned Responders: <span className="font-semibold text-foreground">{r.assignedResponders?.length || 0}</span></p>
                    <p>
                      Last Update: <span className="font-semibold text-foreground">{(r.updatedAt || r.createdAt).toLocaleString()}</span>
                    </p>
                    <p>
                      Resolved At: <span className="font-semibold text-foreground">{r.resolvedAt ? r.resolvedAt.toLocaleString() : "Not yet"}</span>
                    </p>
                  </div>

                  {r.coordinates ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <Route size={13} />
                        Responder Route to Incident
                      </div>

                      {responderLiveRows.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Waiting for assigned responder live location updates.
                        </p>
                      ) : (
                        <>
                          <div className="h-56 overflow-hidden rounded-lg border">
                            <MapContainer
                              center={[r.coordinates.lat, r.coordinates.lng]}
                              zoom={13}
                              scrollWheelZoom
                              className="h-full w-full"
                            >
                              <TileLayer
                                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                attribution="&copy; OpenStreetMap contributors"
                              />

                              <Marker position={[r.coordinates.lat, r.coordinates.lng]}>
                                <Popup>Your incident location</Popup>
                              </Marker>

                              {responderLiveRows.map((live) => (
                                <Marker key={live.uid} position={[live.lat, live.lng]}>
                                  <Popup>
                                    <div className="text-xs">
                                      <p className="font-semibold">Responder {live.uid.slice(0, 6)}</p>
                                      <p>
                                        Updated: {live.updatedAt ? live.updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Unknown"}
                                      </p>
                                    </div>
                                  </Popup>
                                </Marker>
                              ))}

                              {responderLiveRows.map((live) => (
                                <Polyline
                                  key={`${live.uid}-route`}
                                  positions={[
                                    [live.lat, live.lng],
                                    [r.coordinates!.lat, r.coordinates!.lng],
                                  ]}
                                  pathOptions={{ color: "#0284c7", weight: 4, dashArray: "6 6" }}
                                />
                              ))}
                            </MapContainer>
                          </div>

                          <div className="space-y-1">
                            {responderLiveRows.map((live) => (
                              <div key={`${live.uid}-meta`} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                <MapPin size={12} />
                                <span>
                                  Responder {live.uid.slice(0, 6)} at {live.lat.toFixed(5)}, {live.lng.toFixed(5)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Incident coordinates are unavailable.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

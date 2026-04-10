import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Inbox, MapPin, Route } from "lucide-react";
import { useReports } from "@/hooks/useReports";
import { CategoryIcon } from "@/components/CategoryIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { db } from "@/lib/firebase";
import { Timestamp, collection, doc, onSnapshot } from "firebase/firestore";
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

type ResponderNameDirectory = Map<string, string>;

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
                <StatusBadge status={selectedReport.status} />
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
              </div>

              {selectedReport.coordinates ? (
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
                          center={[selectedReport.coordinates.lat, selectedReport.coordinates.lng]}
                          zoom={13}
                          scrollWheelZoom
                          className="h-full w-full"
                        >
                          <TileLayer
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                            attribution="&copy; OpenStreetMap contributors"
                          />

                          <Marker position={[selectedReport.coordinates.lat, selectedReport.coordinates.lng]}>
                            <Popup>Your incident location</Popup>
                          </Marker>

                          {responderLiveRows.map((live) => (
                            <Marker key={live.uid} position={[live.lat, live.lng]}>
                              <Popup>
                                <div className="text-xs">
                                  <p className="font-semibold">
                                    {responderNames.get(live.uid) || "Assigned responder"}
                                  </p>
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
                                [selectedReport.coordinates!.lat, selectedReport.coordinates!.lng],
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
                              {responderNames.get(live.uid) || "Assigned responder"} at {live.lat.toFixed(5)}, {live.lng.toFixed(5)}
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
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

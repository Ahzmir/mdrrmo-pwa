import { useEffect, useState } from "react";
import {
  Timestamp,
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { IncidentReport, IncidentCategory, ReportStatus } from "@/types/incident";
import { getOfflineSmsReportsByResident, subscribeOfflineSmsReports } from "@/lib/offlineSmsReports";

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

function normalizeReportStatus(value: unknown): ReportStatus {
  if (
    value === "pending" ||
    value === "assigned" ||
    value === "en_route" ||
    value === "on_scene" ||
    value === "resolved"
  ) {
    return value;
  }

  if (value === "Pending") return "pending";
  if (value === "Assigned") return "assigned";
  if (value === "En Route") return "en_route";
  if (value === "On Scene") return "on_scene";
  if (value === "Resolved") return "resolved";

  if (value === "Active") return "en_route";
  return "pending";
}

export function useReports() {
  const { user } = useAuth();
  const [reports, setReports] = useState<IncidentReport[]>([]);
  const [offlineReports, setOfflineReports] = useState<IncidentReport[]>([]);

  useEffect(() => {
    if (!user || user.role !== "resident") {
      setOfflineReports([]);
      return;
    }

    const loadOfflineReports = () => {
      const rows = getOfflineSmsReportsByResident(user.id).map((entry) => ({
        id: entry.id,
        category: entry.category as IncidentCategory,
        description: entry.description,
        location: entry.location,
        coordinates: entry.coordinates,
        status: "pending" as ReportStatus,
        createdAt: new Date(entry.createdAtIso),
        updatedAt: new Date(entry.createdAtIso),
        source: "offline_sms",
        offlineSmsPending: true,
        smsNumber: entry.smsNumber,
      } satisfies IncidentReport));

      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      setOfflineReports(rows);
    };

    loadOfflineReports();
    const unsubscribe = subscribeOfflineSmsReports(loadOfflineReports);
    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user || user.role !== "resident") {
      setReports([]);
      return;
    }

    const reportsRef = collection(db, "incidents");
    const reportsQuery = query(reportsRef, where("residentId", "==", user.id));

    const unsubscribe = onSnapshot(
      reportsQuery,
      (snapshot) => {
        const rows = snapshot.docs.map((incidentDoc) => {
          const data = incidentDoc.data() as Record<string, unknown>;
          const createdAt = toDate(data.createdAt) || toDate(data.reportedAt) || new Date();
          const normalizedStatus = normalizeReportStatus(data.status);

          const categoryValue = (data.category as IncidentCategory) || "disaster";
          const assignedResponders = Array.isArray(data.assignedResponders)
            ? (data.assignedResponders as unknown[])
                .filter((entry): entry is string => typeof entry === "string")
            : [];
          const assignedResponderNames = Array.isArray(data.assignedResponderNames)
            ? (data.assignedResponderNames as unknown[])
                .filter((entry): entry is string => typeof entry === "string")
                .map((name) => name.trim())
                .filter((name) => name.length > 0)
            : [];
          const assignedResponderEmails = Array.isArray(data.assignedResponderEmails)
            ? (data.assignedResponderEmails as unknown[])
                .filter((entry): entry is string => typeof entry === "string")
                .map((email) => email.trim().toLowerCase())
                .filter((email) => email.length > 0)
            : [];

          return {
            id: incidentDoc.id,
            category: categoryValue,
            description: (data.description as string) || "",
            location: (data.location as string) || "",
            coordinates:
              typeof data.lat === "number" && typeof data.lng === "number"
                ? { lat: data.lat, lng: data.lng }
                : undefined,
            photoUrl: typeof data.photoUrl === "string" ? data.photoUrl : undefined,
            status: normalizedStatus,
            assignedResponders,
            assignedResponderNames,
            assignedResponderEmails,
            resolvedAt: toDate(data.resolvedAt),
            updatedAt: toDate(data.updatedAt),
            createdAt,
          } satisfies IncidentReport;
        });

        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        setReports(rows);
      },
      () => {
        setReports([]);
      }
    );

    return () => unsubscribe();
  }, [user]);

  return [...reports, ...offlineReports].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

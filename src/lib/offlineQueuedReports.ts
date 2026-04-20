import type { IncidentCategory } from "@/types/incident";

export const OFFLINE_QUEUED_REPORTS_KEY = "mdrrmo_offline_report_queue_v1";
const OFFLINE_QUEUED_REPORTS_EVENT = "mdrrmo:offline-queued-reports-updated";

export type OfflineQueuedReportStatus = "queued" | "sent" | "failed";

export interface OfflineQueuedReportEntry {
  id: string;
  residentId: string;
  residentName: string;
  residentEmail: string;
  residentPhone: string;
  barangay: string;
  category: IncidentCategory;
  description: string;
  location: string;
  coordinates: { lat: number; lng: number };
  createdAtIso: string;
  deliveryStatus: OfflineQueuedReportStatus;
  lastAttemptAtIso: string | null;
  sentAtIso: string | null;
  failureReason: string | null;
  incidentId: string | null;
}

function normalizeDeliveryStatus(value: unknown): OfflineQueuedReportStatus {
  if (value === "queued" || value === "sent" || value === "failed") {
    return value;
  }
  return "queued";
}

function isValidEntry(value: unknown): value is OfflineQueuedReportEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.residentId === "string" &&
    typeof row.residentName === "string" &&
    typeof row.residentEmail === "string" &&
    typeof row.residentPhone === "string" &&
    typeof row.barangay === "string" &&
    (row.category === "fire" || row.category === "medical" || row.category === "crime" || row.category === "disaster") &&
    typeof row.description === "string" &&
    typeof row.location === "string" &&
    !!row.coordinates &&
    typeof row.coordinates === "object" &&
    !Array.isArray(row.coordinates) &&
    Number.isFinite((row.coordinates as { lat?: number }).lat) &&
    Number.isFinite((row.coordinates as { lng?: number }).lng) &&
    typeof row.createdAtIso === "string" &&
    (row.deliveryStatus === undefined || row.deliveryStatus === "queued" || row.deliveryStatus === "sent" || row.deliveryStatus === "failed") &&
    (row.lastAttemptAtIso === undefined || row.lastAttemptAtIso === null || typeof row.lastAttemptAtIso === "string") &&
    (row.sentAtIso === undefined || row.sentAtIso === null || typeof row.sentAtIso === "string") &&
    (row.failureReason === undefined || row.failureReason === null || typeof row.failureReason === "string") &&
    (row.incidentId === undefined || row.incidentId === null || typeof row.incidentId === "string")
  );
}

function readAll(): OfflineQueuedReportEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(OFFLINE_QUEUED_REPORTS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(isValidEntry)
      .map((entry) => ({
        ...entry,
        deliveryStatus: normalizeDeliveryStatus(entry.deliveryStatus),
        lastAttemptAtIso: entry.lastAttemptAtIso ?? null,
        sentAtIso: entry.sentAtIso ?? null,
        failureReason: entry.failureReason ?? null,
        incidentId: entry.incidentId ?? null,
      }));
  } catch {
    return [];
  }
}

function writeAll(rows: OfflineQueuedReportEntry[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(OFFLINE_QUEUED_REPORTS_KEY, JSON.stringify(rows));
  window.dispatchEvent(new Event(OFFLINE_QUEUED_REPORTS_EVENT));
}

export function addOfflineQueuedReport(entry: OfflineQueuedReportEntry) {
  const existing = readAll();
  writeAll([
    {
      ...entry,
      deliveryStatus: normalizeDeliveryStatus(entry.deliveryStatus),
      lastAttemptAtIso: entry.lastAttemptAtIso ?? null,
      sentAtIso: entry.sentAtIso ?? null,
      failureReason: entry.failureReason ?? null,
      incidentId: entry.incidentId ?? null,
    },
    ...existing,
  ]);
}

export function getPendingOfflineQueuedReportsByResident(residentId: string) {
  return readAll().filter(
    (row) => row.residentId === residentId && row.deliveryStatus !== "sent"
  );
}

function updateOfflineQueuedReport(
  id: string,
  updater: (entry: OfflineQueuedReportEntry) => OfflineQueuedReportEntry
) {
  const existing = readAll();
  const next = existing.map((entry) => (entry.id === id ? updater(entry) : entry));
  writeAll(next);
}

export function markOfflineQueuedReportAttempted(id: string) {
  const attemptTimeIso = new Date().toISOString();
  updateOfflineQueuedReport(id, (entry) => ({
    ...entry,
    lastAttemptAtIso: attemptTimeIso,
    failureReason: null,
  }));
}

export function markOfflineQueuedReportSent(id: string, incidentId?: string | null) {
  const sentAtIso = new Date().toISOString();
  updateOfflineQueuedReport(id, (entry) => ({
    ...entry,
    deliveryStatus: "sent",
    sentAtIso,
    lastAttemptAtIso: sentAtIso,
    failureReason: null,
    incidentId: incidentId ?? entry.incidentId ?? null,
  }));
}

export function markOfflineQueuedReportFailed(id: string, reason?: string) {
  const failedAtIso = new Date().toISOString();
  updateOfflineQueuedReport(id, (entry) => ({
    ...entry,
    deliveryStatus: "failed",
    lastAttemptAtIso: failedAtIso,
    failureReason: reason?.trim() || "Auto-sync failed.",
  }));
}

export function subscribeOfflineQueuedReports(onChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === OFFLINE_QUEUED_REPORTS_KEY) {
      onChange();
    }
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(OFFLINE_QUEUED_REPORTS_EVENT, onChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(OFFLINE_QUEUED_REPORTS_EVENT, onChange);
  };
}

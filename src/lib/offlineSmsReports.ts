import type { IncidentCategory } from "@/types/incident";

export const OFFLINE_SMS_REPORTS_KEY = "mdrrmo_offline_sms_reports_v1";
const OFFLINE_SMS_REPORTS_EVENT = "mdrrmo:offline-sms-reports-updated";

export interface OfflineSmsReportEntry {
  id: string;
  residentId: string;
  category: IncidentCategory;
  description: string;
  location: string;
  coordinates: { lat: number; lng: number };
  createdAtIso: string;
  smsNumber: string;
  smsBody: string;
}

function isValidEntry(value: unknown): value is OfflineSmsReportEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.residentId === "string" &&
    (row.category === "fire" || row.category === "medical" || row.category === "crime" || row.category === "disaster") &&
    typeof row.description === "string" &&
    typeof row.location === "string" &&
    !!row.coordinates &&
    typeof row.coordinates === "object" &&
    !Array.isArray(row.coordinates) &&
    Number.isFinite((row.coordinates as { lat?: number }).lat) &&
    Number.isFinite((row.coordinates as { lng?: number }).lng) &&
    typeof row.createdAtIso === "string" &&
    typeof row.smsNumber === "string" &&
    typeof row.smsBody === "string"
  );
}

function readAll(): OfflineSmsReportEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(OFFLINE_SMS_REPORTS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

function writeAll(rows: OfflineSmsReportEntry[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(OFFLINE_SMS_REPORTS_KEY, JSON.stringify(rows));
  window.dispatchEvent(new Event(OFFLINE_SMS_REPORTS_EVENT));
}

export function addOfflineSmsReport(entry: OfflineSmsReportEntry) {
  const existing = readAll();
  writeAll([entry, ...existing]);
}

export function getOfflineSmsReportsByResident(residentId: string) {
  return readAll().filter((row) => row.residentId === residentId);
}

export function subscribeOfflineSmsReports(onChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === OFFLINE_SMS_REPORTS_KEY) {
      onChange();
    }
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(OFFLINE_SMS_REPORTS_EVENT, onChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(OFFLINE_SMS_REPORTS_EVENT, onChange);
  };
}

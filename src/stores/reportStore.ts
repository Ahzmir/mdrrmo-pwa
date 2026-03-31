import { IncidentReport, IncidentCategory, ReportStatus } from "@/types/incident";

let reports: IncidentReport[] = [];
let listeners: (() => void)[] = [];

function notify() {
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function getReports() {
  return reports;
}

export function addReport(data: {
  category: IncidentCategory;
  description: string;
  location: string;
  coordinates?: { lat: number; lng: number };
  photoUrl?: string;
}): IncidentReport {
  const report: IncidentReport = {
    id: crypto.randomUUID(),
    ...data,
    status: "pending",
    createdAt: new Date(),
  };
  reports = [report, ...reports];
  notify();
  return report;
}

export function updateStatus(id: string, status: ReportStatus) {
  reports = reports.map((r) => (r.id === id ? { ...r, status } : r));
  notify();
}

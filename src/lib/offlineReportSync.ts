import { addDoc, collection, getDocFromServer, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  getPendingOfflineQueuedReportsByResident,
  markOfflineQueuedReportAttempted,
  markOfflineQueuedReportFailed,
  markOfflineQueuedReportSent,
} from "@/lib/offlineQueuedReports";

type ResidentIdentity = {
  id: string;
  name: string;
  email: string;
};

let syncInFlight = false;

function getPriorityByCategory(category: "fire" | "medical" | "crime" | "disaster"): "Critical" | "High" {
  if (category === "fire" || category === "medical") {
    return "Critical";
  }
  return "High";
}

function getTitleByCategory(category: "fire" | "medical" | "crime" | "disaster"): string {
  if (category === "fire") return "Fire Incident";
  if (category === "medical") return "Medical Emergency";
  if (category === "disaster") return "Disaster Incident";
  return "Crime Incident";
}

function isConnectivityError(error: unknown) {
  const code = (error as { code?: string })?.code || "";
  return code === "unavailable" || code === "deadline-exceeded" || code === "resource-exhausted";
}

export async function syncOfflineQueuedReportsForResident(resident: ResidentIdentity) {
  if (syncInFlight || typeof window === "undefined" || !navigator.onLine) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  syncInFlight = true;

  try {
    const pending = getPendingOfflineQueuedReportsByResident(resident.id);
    let sent = 0;
    let failed = 0;

    for (const entry of pending) {
      if (!navigator.onLine) {
        break;
      }

      markOfflineQueuedReportAttempted(entry.id);

      try {
        const incidentRef = await addDoc(collection(db, "incidents"), {
          title: getTitleByCategory(entry.category),
          category: entry.category,
          description: entry.description,
          priority: getPriorityByCategory(entry.category),
          status: "Pending",
          source: "Web",
          location: entry.location,
          barangay: entry.barangay || "Banisilan",
          lat: entry.coordinates.lat,
          lng: entry.coordinates.lng,
          photoUrl: null,
          residentId: entry.residentId || resident.id,
          residentName: entry.residentName || resident.name,
          residentEmail: entry.residentEmail || resident.email,
          residentPhone: entry.residentPhone || "",
          assignedResponders: [],
          reportedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const createdDoc = await getDocFromServer(incidentRef);
        if (!createdDoc.exists()) {
          throw new Error(`Incident write was not visible on server yet. Doc ID: ${incidentRef.id}`);
        }

        markOfflineQueuedReportSent(entry.id, incidentRef.id);
        sent += 1;
      } catch (error) {
        const reason = (error as { message?: string }).message || "Unable to auto-send queued report.";
        markOfflineQueuedReportFailed(entry.id, reason);
        failed += 1;

        if (!isConnectivityError(error)) {
          // Retry on next app cycle; stop current batch on non-network errors.
          break;
        }
      }
    }

    return { processed: pending.length, sent, failed };
  } finally {
    syncInFlight = false;
  }
}

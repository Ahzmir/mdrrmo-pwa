import { httpsCallable } from "firebase/functions";
import type { IncidentCategory } from "@/types/incident";
import { functions } from "@/lib/firebase";

export interface SmsFallbackCoordinates {
  lat: number;
  lng: number;
}

export interface SubmitSmsFallbackReportPayload {
  reportId: string;
  smsBody: string;
  category: IncidentCategory;
  description: string;
  location: string;
  coordinates: SmsFallbackCoordinates;
  createdAtIso: string;
  reporterName: string;
  reporterPhone?: string | null;
  reporterEmail?: string | null;
}

interface SubmitSmsFallbackReportResult {
  ok: boolean;
  destination: string;
  provider: "semaphore";
  semaphoreMessageIds: string[];
}

const submitSmsFallbackReportCallable = httpsCallable<
  SubmitSmsFallbackReportPayload,
  SubmitSmsFallbackReportResult
>(functions, "submitSmsFallbackReport");

export async function submitSmsFallbackReport(payload: SubmitSmsFallbackReportPayload) {
  const response = await submitSmsFallbackReportCallable(payload);
  return response.data;
}

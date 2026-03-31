export type IncidentCategory = "fire" | "medical" | "crime" | "disaster";

export type ReportStatus =
  | "pending"
  | "assigned"
  | "en_route"
  | "on_scene"
  | "resolved";

export interface IncidentReport {
  id: string;
  category: IncidentCategory;
  description: string;
  location: string;
  coordinates?: { lat: number; lng: number };
  photoUrl?: string;
  status: ReportStatus;
  assignedResponders?: string[];
  resolvedAt?: Date | null;
  updatedAt?: Date | null;
  responderAssignmentStatus?: "assigned" | "accepted" | "rejected";
  responderAssignmentReason?: string;
  createdAt: Date;
}

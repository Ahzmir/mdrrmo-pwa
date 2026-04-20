import { useEffect, useState } from "react";
import { Timestamp, collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { IncidentReport, IncidentCategory, ReportStatus } from "@/types/incident";

function pushIncidentDebugLog(message: string, isError = false) {
  const debugEnabled =
    typeof window !== "undefined" && window.localStorage.getItem("mdrrmo_debug_incidents") === "1";
  if (!debugEnabled) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const line = `[${timestamp}] ${message}`;

  if (isError) {
    console.error(`[useIncidents] ${line}`);
  } else {
    console.info(`[useIncidents] ${line}`);
  }

  if (typeof window !== "undefined") {
    const host = window as Window & { __mdrrmoIncidentDebug?: string[] };
    const current = host.__mdrrmoIncidentDebug || [];
    host.__mdrrmoIncidentDebug = [...current, line].slice(-40);
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function toCategory(value: unknown): IncidentCategory {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized.includes("fire")) return "fire";
  if (normalized.includes("medical") || normalized.includes("health")) return "medical";
  if (
    normalized.includes("crime") ||
    normalized.includes("theft") ||
    normalized.includes("violence") ||
    normalized.includes("suspicious")
  ) {
    return "crime";
  }
  if (normalized.includes("disaster") || normalized.includes("flood") || normalized.includes("storm")) {
    return "disaster";
  }
  return "fire";
}

function toStatus(value: unknown): ReportStatus {
  if (
    value === "pending" ||
    value === "assigned" ||
    value === "en_route" ||
    value === "on_scene" ||
    value === "resolved"
  ) {
    return value;
  }

  if (value === "Resolved") return "resolved";
  if (value === "Active") return "en_route";
  if (value === "Pending") return "pending";
  return "pending";
}

function toFiniteNumber(value: unknown) {
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

function normalizeCoordinates(rawLat: unknown, rawLng: unknown): { lat: number; lng: number } | null {
  const lat = toFiniteNumber(rawLat);
  const lng = toFiniteNumber(rawLng);

  if (lat === null || lng === null) {
    return null;
  }

  if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }

  // Recover records where lat/lng were accidentally stored in swapped fields.
  if (Math.abs(lng) <= 90 && Math.abs(lat) <= 180) {
    return { lat: lng, lng: lat };
  }

  return null;
}

export function useIncidents() {
  const { user } = useAuth();
  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const responderRole = user?.role;
  const responderUid = user?.id || "";
  const responderEmail = user?.email || "";

  useEffect(() => {
    if (!responderUid || responderRole !== "responder") {
      pushIncidentDebugLog("Hook reset: user missing or not responder.");
      setIncidents([]);
      return;
    }

    pushIncidentDebugLog(`Hook start uid=${responderUid} email=${responderEmail}.`);

    let active = true;
    const unsubscribeList: Array<() => void> = [];
    const snapshotsByKey = new Map<string, Map<string, IncidentReport>>();

    const toIncidentReport = (incidentId: string, data: Record<string, unknown>): IncidentReport => {
      const normalizedCoordinates = normalizeCoordinates(data.lat, data.lng);
      const responses =
        data.responderResponses && typeof data.responderResponses === "object" && !Array.isArray(data.responderResponses)
          ? (data.responderResponses as Record<string, unknown>)
          : null;
      const currentResponse =
        responses && responses[responderUid] && typeof responses[responderUid] === "object"
          ? (responses[responderUid] as Record<string, unknown>)
          : null;
      const responderAssignmentStatus =
        currentResponse?.status === "assigned" ||
        currentResponse?.status === "accepted" ||
        currentResponse?.status === "rejected"
          ? (currentResponse.status as "assigned" | "accepted" | "rejected")
          : undefined;
      const responderAssignmentReason =
        typeof currentResponse?.reason === "string" ? currentResponse.reason : undefined;

      return {
        id: incidentId,
        category: toCategory(data.category),
        description: (data.description as string) || "No description provided.",
        location: (data.location as string) || "",
        coordinates: normalizedCoordinates ?? undefined,
        photoUrl: typeof data.photoUrl === "string" ? data.photoUrl : undefined,
        status: toStatus(data.status),
        responderAssignmentStatus,
        responderAssignmentReason,
        createdAt: toDate(data.createdAt || data.reportedAt),
      };
    };

    const emitMergedRows = () => {
      const merged = new Map<string, IncidentReport>();

      snapshotsByKey.forEach((incidentMap) => {
        incidentMap.forEach((incident, incidentId) => {
          merged.set(incidentId, incident);
        });
      });

      setIncidents(
        Array.from(merged.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      );
      pushIncidentDebugLog(`Merged incidents=${merged.size}.`);
    };

    const subscribeByResponderId = (assignedResponderId: string) => {
      pushIncidentDebugLog(`Subscribing by assignedResponders contains uid=${assignedResponderId}.`);
      const incidentsRef = collection(db, "incidents");
      const incidentsQuery = query(incidentsRef, where("assignedResponders", "array-contains", assignedResponderId));

      const unsubscribe = onSnapshot(
        incidentsQuery,
        (snapshot) => {
          const incidentMap = new Map<string, IncidentReport>();

          snapshot.docs.forEach((incidentDoc) => {
            const data = incidentDoc.data() as Record<string, unknown>;
            incidentMap.set(incidentDoc.id, toIncidentReport(incidentDoc.id, data));
          });

          pushIncidentDebugLog(
            `UID query uid=${assignedResponderId} docs=${snapshot.docs.length} ids=${snapshot.docs
              .map((docItem) => docItem.id)
              .join(",") || "none"}.`
          );

          snapshotsByKey.set(`uid:${assignedResponderId}`, incidentMap);
          emitMergedRows();
        },
        (error) => {
          const code = (error as { code?: string }).code || "unknown";
          pushIncidentDebugLog(`UID query failed uid=${assignedResponderId} code=${code} msg=${error.message}`, true);
          snapshotsByKey.set(`uid:${assignedResponderId}`, new Map());
          emitMergedRows();
        }
      );

      unsubscribeList.push(unsubscribe);
    };

    const subscribeByResponderResponseAccepted = (responderId: string) => {
      if (!responderId) {
        return;
      }

      pushIncidentDebugLog(`Subscribing by responderResponses.${responderId}.status == accepted.`);
      const incidentsRef = collection(db, "incidents");
      const acceptedQuery = query(
        incidentsRef,
        where(`responderResponses.${responderId}.status`, "==", "accepted")
      );

      const unsubscribe = onSnapshot(
        acceptedQuery,
        (snapshot) => {
          const incidentMap = new Map<string, IncidentReport>();

          snapshot.docs.forEach((incidentDoc) => {
            const data = incidentDoc.data() as Record<string, unknown>;
            incidentMap.set(incidentDoc.id, toIncidentReport(incidentDoc.id, data));
          });

          pushIncidentDebugLog(
            `Accepted-response query id=${responderId} docs=${snapshot.docs.length} ids=${snapshot.docs
              .map((docItem) => docItem.id)
              .join(",") || "none"}.`
          );

          snapshotsByKey.set(`accepted-response:${responderId}`, incidentMap);
          emitMergedRows();
        },
        (error) => {
          const code = (error as { code?: string }).code || "unknown";
          pushIncidentDebugLog(
            `Accepted-response query failed id=${responderId} code=${code} msg=${error.message}`,
            true
          );
          snapshotsByKey.set(`accepted-response:${responderId}`, new Map());
          emitMergedRows();
        }
      );

      unsubscribeList.push(unsubscribe);
    };

    const subscribeResolvedByStatusFallback = (responderIds: string[], normalizedEmail: string) => {
      pushIncidentDebugLog("Subscribing to resolved-status fallback query.");
      const incidentsRef = collection(db, "incidents");
      const resolvedQuery = query(incidentsRef, where("status", "==", "resolved"));

      const responderIdSet = new Set(responderIds.filter(Boolean));
      const responderEmail = normalizedEmail.trim().toLowerCase();

      const unsubscribe = onSnapshot(
        resolvedQuery,
        (snapshot) => {
          const incidentMap = new Map<string, IncidentReport>();

          snapshot.docs.forEach((incidentDoc) => {
            const data = incidentDoc.data() as Record<string, unknown>;

            const assignedResponders = Array.isArray(data.assignedResponders)
              ? (data.assignedResponders as unknown[]).filter((value): value is string => typeof value === "string")
              : [];
            const assignedResponderEmails = Array.isArray(data.assignedResponderEmails)
              ? (data.assignedResponderEmails as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim().toLowerCase())
              : [];
            const historyIds = Array.isArray(data.responderHistoryIds)
              ? (data.responderHistoryIds as unknown[]).filter((value): value is string => typeof value === "string")
              : [];
            const historyEmails = Array.isArray(data.responderHistoryEmails)
              ? (data.responderHistoryEmails as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim().toLowerCase())
              : [];

            const responses =
              data.responderResponses && typeof data.responderResponses === "object" && !Array.isArray(data.responderResponses)
                ? (data.responderResponses as Record<string, unknown>)
                : {};

            const linkedById =
              assignedResponders.some((id) => responderIdSet.has(id)) ||
              historyIds.some((id) => responderIdSet.has(id)) ||
              Object.keys(responses).some((id) => responderIdSet.has(id));

            const linkedByEmail =
              !!responderEmail &&
              (assignedResponderEmails.includes(responderEmail) || historyEmails.includes(responderEmail));

            if (!linkedById && !linkedByEmail) {
              return;
            }

            incidentMap.set(incidentDoc.id, toIncidentReport(incidentDoc.id, data));
          });

          pushIncidentDebugLog(
            `Resolved fallback query docs=${snapshot.docs.length} kept=${incidentMap.size}.`
          );

          snapshotsByKey.set("resolved-fallback", incidentMap);
          emitMergedRows();
        },
        (error) => {
          const code = (error as { code?: string }).code || "unknown";
          pushIncidentDebugLog(
            `Resolved fallback query failed code=${code} msg=${error.message}`,
            true
          );
          snapshotsByKey.set("resolved-fallback", new Map());
          emitMergedRows();
        }
      );

      unsubscribeList.push(unsubscribe);
    };

    const subscribeResolvedHistoryByResponderId = (historyResponderId: string) => {
      pushIncidentDebugLog(`Subscribing by responderHistoryIds contains uid=${historyResponderId}.`);
      const incidentsRef = collection(db, "incidents");
      const historyQuery = query(incidentsRef, where("responderHistoryIds", "array-contains", historyResponderId));

      const unsubscribe = onSnapshot(
        historyQuery,
        (snapshot) => {
          const incidentMap = new Map<string, IncidentReport>();

          snapshot.docs.forEach((incidentDoc) => {
            const data = incidentDoc.data() as Record<string, unknown>;
            incidentMap.set(incidentDoc.id, toIncidentReport(incidentDoc.id, data));
          });

          pushIncidentDebugLog(
            `History UID query uid=${historyResponderId} docs=${snapshot.docs.length} ids=${snapshot.docs
              .map((docItem) => docItem.id)
              .join(",") || "none"}.`
          );

          snapshotsByKey.set(`history-uid:${historyResponderId}`, incidentMap);
          emitMergedRows();
        },
        (error) => {
          const code = (error as { code?: string }).code || "unknown";
          pushIncidentDebugLog(
            `History UID query failed uid=${historyResponderId} code=${code} msg=${error.message}`,
            true
          );
          snapshotsByKey.set(`history-uid:${historyResponderId}`, new Map());
          emitMergedRows();
        }
      );

      unsubscribeList.push(unsubscribe);
    };

    const initialize = async () => {
      const normalizedEmail = responderEmail.trim().toLowerCase();

      // Always subscribe to auth UID immediately so incident feed cannot stall.
      subscribeByResponderId(responderUid);
      subscribeResolvedHistoryByResponderId(responderUid);

      const authUid = auth.currentUser?.uid || "";
      const responderIdCandidates = Array.from(new Set([responderUid, authUid].filter(Boolean)));
      responderIdCandidates.forEach((candidateId) => {
        subscribeByResponderResponseAccepted(candidateId);
      });
      subscribeResolvedByStatusFallback(responderIdCandidates, normalizedEmail);

      // Fallback path: include incident referenced by responder currentIncidentId.
      const responderRef = doc(db, "responders", responderUid);
      let currentIncidentUnsubscribe: (() => void) | null = null;
      let lastCurrentIncidentId: string | null = null;
      const unsubscribeResponder = onSnapshot(
        responderRef,
        (responderSnapshot) => {
          const currentIncidentId =
            responderSnapshot.exists() && typeof responderSnapshot.data().currentIncidentId === "string"
              ? (responderSnapshot.data().currentIncidentId as string)
              : null;

          pushIncidentDebugLog(`Responder doc currentIncidentId=${currentIncidentId || "none"}.`);

          if (currentIncidentId === lastCurrentIncidentId) {
            return;
          }

          lastCurrentIncidentId = currentIncidentId;

          if (currentIncidentUnsubscribe) {
            try {
              currentIncidentUnsubscribe();
            } catch {
              // Ignore teardown failures from transient Firestore stream state.
            }
            currentIncidentUnsubscribe = null;
          }

          if (!currentIncidentId) {
            snapshotsByKey.set("currentIncident", new Map());
            emitMergedRows();
            return;
          }

          const incidentRef = doc(db, "incidents", currentIncidentId);
          currentIncidentUnsubscribe = onSnapshot(
            incidentRef,
            (incidentSnapshot) => {
              const nextMap = new Map<string, IncidentReport>();
              if (incidentSnapshot.exists()) {
                const incidentData = incidentSnapshot.data() as Record<string, unknown>;
                const status = toStatus(incidentData.status);
                if (status !== "resolved") {
                  nextMap.set(currentIncidentId, toIncidentReport(currentIncidentId, incidentData));
                }
                pushIncidentDebugLog(
                  `currentIncident status=${status} kept=${status !== "resolved" ? "yes" : "no"}.`
                );
              }
              pushIncidentDebugLog(
                `currentIncident listener incident=${currentIncidentId} exists=${incidentSnapshot.exists()}.`
              );
              snapshotsByKey.set("currentIncident", nextMap);
              emitMergedRows();
            },
            (error) => {
              const code = (error as { code?: string }).code || "unknown";
              pushIncidentDebugLog(
                `currentIncident listener failed incident=${currentIncidentId} code=${code} msg=${error.message}`,
                true
              );
              snapshotsByKey.set("currentIncident", new Map());
              emitMergedRows();
            }
          );
        },
        (error) => {
          const code = (error as { code?: string }).code || "unknown";
          pushIncidentDebugLog(`Responder doc listener failed code=${code} msg=${error.message}`, true);
          snapshotsByKey.set("currentIncident", new Map());
          emitMergedRows();
        }
      );

      unsubscribeList.push(() => {
        try {
          unsubscribeResponder();
        } catch {
          // Ignore teardown failures from transient Firestore stream state.
        }
        if (currentIncidentUnsubscribe) {
          try {
            currentIncidentUnsubscribe();
          } catch {
            // Ignore teardown failures from transient Firestore stream state.
          }
        }
      });

      if (normalizedEmail) {
        pushIncidentDebugLog(`Subscribing by assignedResponderEmails contains email=${normalizedEmail}.`);
        const incidentsRef = collection(db, "incidents");
        const emailQuery = query(incidentsRef, where("assignedResponderEmails", "array-contains", normalizedEmail));
        const unsubscribeEmail = onSnapshot(
          emailQuery,
          (snapshot) => {
            const incidentMap = new Map<string, IncidentReport>();

            snapshot.docs.forEach((incidentDoc) => {
              const data = incidentDoc.data() as Record<string, unknown>;
              incidentMap.set(incidentDoc.id, toIncidentReport(incidentDoc.id, data));
            });

            pushIncidentDebugLog(
              `Email query email=${normalizedEmail} docs=${snapshot.docs.length} ids=${snapshot.docs
                .map((docItem) => docItem.id)
                .join(",") || "none"}.`
            );

            snapshotsByKey.set(`email:${normalizedEmail}`, incidentMap);
            emitMergedRows();
          },
          (error) => {
            const code = (error as { code?: string }).code || "unknown";
            pushIncidentDebugLog(`Email query failed email=${normalizedEmail} code=${code} msg=${error.message}`, true);
            snapshotsByKey.set(`email:${normalizedEmail}`, new Map());
            emitMergedRows();
          }
        );

        unsubscribeList.push(unsubscribeEmail);

        pushIncidentDebugLog(`Subscribing by responderHistoryEmails contains email=${normalizedEmail}.`);
        const historyEmailQuery = query(incidentsRef, where("responderHistoryEmails", "array-contains", normalizedEmail));
        const unsubscribeHistoryEmail = onSnapshot(
          historyEmailQuery,
          (snapshot) => {
            const incidentMap = new Map<string, IncidentReport>();

            snapshot.docs.forEach((incidentDoc) => {
              const data = incidentDoc.data() as Record<string, unknown>;
              incidentMap.set(incidentDoc.id, toIncidentReport(incidentDoc.id, data));
            });

            pushIncidentDebugLog(
              `History email query email=${normalizedEmail} docs=${snapshot.docs.length} ids=${snapshot.docs
                .map((docItem) => docItem.id)
                .join(",") || "none"}.`
            );

            snapshotsByKey.set(`history-email:${normalizedEmail}`, incidentMap);
            emitMergedRows();
          },
          (error) => {
            const code = (error as { code?: string }).code || "unknown";
            pushIncidentDebugLog(
              `History email query failed email=${normalizedEmail} code=${code} msg=${error.message}`,
              true
            );
            snapshotsByKey.set(`history-email:${normalizedEmail}`, new Map());
            emitMergedRows();
          }
        );

        unsubscribeList.push(unsubscribeHistoryEmail);
      }
    };

    void initialize();

    return () => {
      active = false;
      pushIncidentDebugLog("Hook cleanup.");
      unsubscribeList.forEach((unsubscribe) => {
        try {
          unsubscribe();
        } catch {
          // Guard against Firestore SDK assertion during teardown.
        }
      });
    };
  }, [responderEmail, responderRole, responderUid]);

  return incidents;
}

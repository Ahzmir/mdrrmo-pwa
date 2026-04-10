import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDocFromServer,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { ReportStatus } from "@/types/incident";

function logIncidentAction(message: string, payload?: unknown, isError = false) {
  const timestamp = new Date().toISOString();
  const line = `[incident-action ${timestamp}] ${message}`;

  if (isError) {
    console.error(line, payload ?? "");
  } else {
    console.info(line, payload ?? "");
  }

  if (typeof window !== "undefined") {
    const host = window as Window & { __mdrrmoIncidentActionDebug?: string[] };
    const current = host.__mdrrmoIncidentActionDebug || [];
    const serializedPayload = payload === undefined ? "" : ` ${JSON.stringify(payload)}`;
    host.__mdrrmoIncidentActionDebug = [...current, `${line}${serializedPayload}`].slice(-80);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: number | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };

  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((entry) => toFirestoreValue(entry)),
      },
    };
  }

  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }

  if (typeof value === "object") {
    const fields: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, entryValue]) => {
      fields[key] = toFirestoreValue(entryValue);
    });
    return {
      mapValue: {
        fields,
      },
    };
  }

  return { stringValue: String(value) };
}

function createUpdateMaskQuery(fieldPaths: string[]) {
  return fieldPaths.map((fieldPath) => `updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`).join("&");
}

async function patchFirestoreDocumentViaRest(
  collectionName: "incidents" | "responders",
  docId: string,
  payload: Record<string, unknown>,
  fieldPaths: string[]
) {
  if (!auth.currentUser) {
    throw new Error("No authenticated session for REST fallback.");
  }

  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  if (!projectId) {
    throw new Error("Missing VITE_FIREBASE_PROJECT_ID for REST fallback.");
  }

  const token = await auth.currentUser.getIdToken();
  const encodedId = encodeURIComponent(docId);
  const query = createUpdateMaskQuery(fieldPaths);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionName}/${encodedId}?${query}`;

  const fields: Record<string, unknown> = {};
  Object.entries(payload).forEach(([key, value]) => {
    fields[key] = toFirestoreValue(value);
  });

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST patch failed (${response.status}): ${text}`);
  }
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("timed out");
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((entry) => typeof entry === "string" && entry.trim().length > 0)));
}

async function resolveResponderDocIdByAuthUid(responderUid: string) {
  const directRef = doc(db, "responders", responderUid);
  try {
    const directSnap = await withTimeout(getDocFromServer(directRef), 8000, "resolve responder direct doc");
    if (directSnap.exists()) {
      logIncidentAction("responder-doc-resolve:direct", { responderUid, responderDocId: responderUid });
      return responderUid;
    }
  } catch (error) {
    const code = (error as { code?: string }).code || "unknown";
    logIncidentAction(
      "responder-doc-resolve:direct-failed",
      { responderUid, code, message: (error as Error).message },
      true
    );
  }

  const respondersRef = collection(db, "responders");
  const byUidQuery = query(respondersRef, where("uid", "==", responderUid), limit(1));
  const querySnap = await withTimeout(getDocs(byUidQuery), 8000, "resolve responder by uid query");
  if (!querySnap.empty) {
    const responderDocId = querySnap.docs[0].id;
    logIncidentAction("responder-doc-resolve:query", { responderUid, responderDocId });
    return responderDocId;
  }

  logIncidentAction("responder-doc-resolve:fallback", { responderUid, responderDocId: responderUid }, true);
  return responderUid;
}

export async function acceptIncident(id: string) {
  const responderUid = auth.currentUser?.uid;
  const responderEmail = auth.currentUser?.email?.trim().toLowerCase() || null;
  if (!responderUid) {
    throw new Error("You must be logged in to accept an incident.");
  }

  const incidentRef = doc(db, "incidents", id);
  const responderDocId = await resolveResponderDocIdByAuthUid(responderUid);
  const responderRef = doc(db, "responders", responderDocId);
  logIncidentAction("accept:start", { incidentId: id, responderUid, responderEmail });

  // Debug preflight should never block accept writes.
  void getDocFromServer(incidentRef)
    .then((beforeSnap) => {
      const beforeData = beforeSnap.data() as Record<string, unknown> | undefined;
      logIncidentAction("accept:preflight", {
        incidentId: id,
        currentStatus: beforeData?.status ?? null,
        assignedResponders: Array.isArray(beforeData?.assignedResponders)
          ? beforeData?.assignedResponders
          : [],
        assignedResponderEmails: Array.isArray(beforeData?.assignedResponderEmails)
          ? beforeData?.assignedResponderEmails
          : [],
        responderResponse:
          beforeData?.responderResponses && typeof beforeData.responderResponses === "object"
            ? (beforeData.responderResponses as Record<string, unknown>)[responderUid] ?? null
            : null,
      });
    })
    .catch((error) => {
      const code = (error as { code?: string }).code || "unknown";
      logIncidentAction("accept:preflight-failed", { incidentId: id, code, message: (error as Error).message }, true);
    });

  try {
    const incidentUpdate: Record<string, unknown> = {
      status: "en_route",
      resolvedAt: null,
      assignedResponders: arrayUnion(responderUid),
      [`responderResponses.${responderUid}`]: {
        status: "accepted",
        reason: null,
        respondedAt: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    };

    if (responderEmail) {
      incidentUpdate.assignedResponderEmails = arrayUnion(responderEmail);
    }

    logIncidentAction("accept:incident-update-attempt", { incidentId: id });
    try {
      await withTimeout(updateDoc(incidentRef, incidentUpdate), 12000, "accept incident update");
    } catch (writeError) {
      if (!isTimeoutError(writeError)) {
        throw writeError;
      }

      logIncidentAction("accept:incident-update-timeout-fallback", { incidentId: id }, true);
      logIncidentAction("accept:incident-fallback-pre-read-attempt", { incidentId: id });
      let existingResponses: Record<string, unknown> = {};

      try {
        const fallbackSnap = await withTimeout(
          getDocFromServer(incidentRef),
          8000,
          "accept fallback pre-read"
        );
        const fallbackData = fallbackSnap.data() as Record<string, unknown> | undefined;
        existingResponses =
          fallbackData?.responderResponses && typeof fallbackData.responderResponses === "object"
            ? (fallbackData.responderResponses as Record<string, unknown>)
            : {};
        logIncidentAction("accept:incident-fallback-pre-read-ok", { incidentId: id });
      } catch (preReadError) {
        const code = (preReadError as { code?: string }).code || "unknown";
        logIncidentAction(
          "accept:incident-fallback-pre-read-failed",
          { incidentId: id, code, message: (preReadError as Error).message },
          true
        );
      }

      const normalizedResponses =
        existingResponses && typeof existingResponses === "object" ? existingResponses : {};
      const nextResponses = {
        ...normalizedResponses,
        [responderUid]: {
          status: "accepted",
          reason: null,
          respondedAt: new Date(),
        },
      };

      const restPayload: Record<string, unknown> = {
        status: "en_route",
        resolvedAt: null,
        responderResponses: nextResponses,
        updatedAt: new Date(),
      };
      const updateFields = ["status", "resolvedAt", "responderResponses", "updatedAt"];

      logIncidentAction("accept:incident-rest-fallback-attempt", { incidentId: id, updateFields });
      await withTimeout(
        patchFirestoreDocumentViaRest("incidents", id, restPayload, updateFields),
        12000,
        "accept incident REST fallback"
      );
      logIncidentAction("accept:incident-rest-fallback-ok", { incidentId: id });
    }
    logIncidentAction("accept:incident-update-ok", { incidentId: id, status: "en_route" });

    try {
      const serverIncidentSnap = await withTimeout(
        getDocFromServer(incidentRef),
        12000,
        "accept server readback"
      );
      const serverData = serverIncidentSnap.data() as Record<string, unknown> | undefined;
      const serverStatus = serverData?.status;
      const serverAssignedResponders = Array.isArray(serverData?.assignedResponders)
        ? (serverData?.assignedResponders as unknown[])
        : [];
      const serverResponses =
        serverData?.responderResponses && typeof serverData.responderResponses === "object"
          ? (serverData.responderResponses as Record<string, unknown>)
          : {};

      logIncidentAction("accept:server-readback", {
        incidentId: id,
        serverStatus,
        assignedContainsResponder: serverAssignedResponders.includes(responderUid),
        responderResponse: serverResponses[responderUid] ?? null,
      });
    } catch (readbackError) {
      const code = (readbackError as { code?: string }).code || "unknown";
      logIncidentAction(
        "accept:server-readback-nonfatal",
        { incidentId: id, code, message: (readbackError as Error).message },
        true
      );
    }

    logIncidentAction("accept:responder-update-attempt", { responderUid, responderDocId, incidentId: id });
    try {
      await withTimeout(
        updateDoc(responderRef, {
          status: "Deployed",
          currentIncidentId: id,
          updatedAt: serverTimestamp(),
        }),
        12000,
        "accept responder update"
      );
    } catch (responderWriteError) {
      if (!isTimeoutError(responderWriteError)) {
        const code = (responderWriteError as { code?: string }).code || "unknown";
        logIncidentAction(
          "accept:responder-update-nonfatal",
          { responderUid, incidentId: id, code, message: (responderWriteError as Error).message },
          true
        );
      } else {
        logIncidentAction("accept:responder-update-timeout-fallback", { responderUid, incidentId: id }, true);
        try {
          await withTimeout(
            patchFirestoreDocumentViaRest(
              "responders",
              responderDocId,
              {
                status: "Deployed",
                currentIncidentId: id,
                updatedAt: new Date(),
              },
              ["status", "currentIncidentId", "updatedAt"]
            ),
            12000,
            "accept responder REST fallback"
          );
          logIncidentAction("accept:responder-rest-fallback-ok", { responderUid, responderDocId, incidentId: id });
        } catch (fallbackResponderError) {
          const code = (fallbackResponderError as { code?: string }).code || "unknown";
          logIncidentAction(
            "accept:responder-rest-fallback-nonfatal",
            { responderUid, responderDocId, incidentId: id, code, message: (fallbackResponderError as Error).message },
            true
          );
        }
      }
    }
    logIncidentAction("accept:responder-update-ok", {
      responderUid,
      responderDocId,
      currentIncidentId: id,
      responderStatus: "Deployed",
    });
  } catch (error) {
    const code = (error as { code?: string }).code || "unknown";
    logIncidentAction("accept:failed", { incidentId: id, code, message: (error as Error).message }, true);
    throw error;
  }
}

export async function rejectIncident(id: string, reason: string) {
  const responderUid = auth.currentUser?.uid;
  if (!responderUid) {
    throw new Error("You must be logged in to decline an incident.");
  }

  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new Error("Please provide a reason for rejecting this incident.");
  }

  const incidentRef = doc(db, "incidents", id);
  const responderDocId = await resolveResponderDocIdByAuthUid(responderUid);
  const responderRef = doc(db, "responders", responderDocId);
  const normalizedEmail = auth.currentUser?.email?.trim().toLowerCase() || null;
  logIncidentAction("reject:start", { incidentId: id, responderUid, normalizedEmail, reason: trimmedReason });

  const incidentUpdate: Record<string, unknown> = {
    assignedResponders: arrayRemove(responderUid),
    status: "pending",
    [`responderResponses.${responderUid}`]: {
      status: "rejected",
      reason: trimmedReason,
      respondedAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  };

  if (normalizedEmail) {
    incidentUpdate.assignedResponderEmails = arrayRemove(normalizedEmail);
  }

  try {
    logIncidentAction("reject:incident-update-attempt", { incidentId: id });
    await withTimeout(
      updateDoc(incidentRef, {
        ...incidentUpdate,
      }),
      12000,
      "reject incident update"
    );
    logIncidentAction("reject:incident-update-ok", { incidentId: id, status: "pending" });

    logIncidentAction("reject:responder-update-attempt", { responderUid, responderDocId, incidentId: id });
    await withTimeout(
      updateDoc(responderRef, {
        status: "Available",
        currentIncidentId: null,
        updatedAt: serverTimestamp(),
      }),
      12000,
      "reject responder update"
    );
    logIncidentAction("reject:responder-update-ok", {
      responderUid,
      responderDocId,
      currentIncidentId: null,
      responderStatus: "Available",
    });
  } catch (error) {
    const code = (error as { code?: string }).code || "unknown";
    logIncidentAction("reject:failed", { incidentId: id, code, message: (error as Error).message }, true);
    throw error;
  }
}

export async function updateIncidentStatus(id: string, status: ReportStatus) {
  const responderUid = auth.currentUser?.uid;
  const responderEmail = auth.currentUser?.email?.trim().toLowerCase() || null;
  const incidentRef = doc(db, "incidents", id);
  logIncidentAction("status-toggle:start", { incidentId: id, nextStatus: status, responderUid, responderEmail });

  try {
    const incidentUpdate: Record<string, unknown> = {
      status,
      resolvedAt: status === "resolved" ? serverTimestamp() : null,
      updatedAt: serverTimestamp(),
    };

    if (status === "resolved") {
      // Keep resolver linkage so responder queries continue to include resolved incidents.
      if (responderUid) {
        incidentUpdate.assignedResponders = arrayUnion(responderUid);
        incidentUpdate.responderHistoryIds = arrayUnion(responderUid);
      }
      if (responderEmail) {
        incidentUpdate.assignedResponderEmails = arrayUnion(responderEmail);
        incidentUpdate.responderHistoryEmails = arrayUnion(responderEmail);
      }
    } else if (responderUid) {
      incidentUpdate.assignedResponders = arrayRemove(responderUid);
      if (responderEmail) {
        incidentUpdate.assignedResponderEmails = arrayRemove(responderEmail);
      }
    }

    logIncidentAction("status-toggle:incident-update-attempt", { incidentId: id, nextStatus: status });
    try {
      await withTimeout(updateDoc(incidentRef, incidentUpdate), 12000, "status toggle incident update");
    } catch (statusWriteError) {
      if (!isTimeoutError(statusWriteError)) {
        throw statusWriteError;
      }

      logIncidentAction("status-toggle:incident-update-timeout-fallback", { incidentId: id, nextStatus: status }, true);
      const restPayload: Record<string, unknown> = {
        status,
        resolvedAt: status === "resolved" ? new Date() : null,
        updatedAt: new Date(),
      };
      const updateFields = ["status", "resolvedAt", "updatedAt"];
      await withTimeout(
        patchFirestoreDocumentViaRest("incidents", id, restPayload, updateFields),
        12000,
        "status toggle incident REST fallback"
      );
      logIncidentAction("status-toggle:incident-rest-fallback-ok", { incidentId: id, nextStatus: status });
    }
    logIncidentAction("status-toggle:incident-update-ok", { incidentId: id, nextStatus: status });

    try {
      const serverIncidentSnap = await withTimeout(
        getDocFromServer(incidentRef),
        12000,
        "status toggle server readback"
      );
      const serverStatus = serverIncidentSnap.data()?.status;
      logIncidentAction("status-toggle:server-readback", {
        incidentId: id,
        expectedStatus: status,
        serverStatus,
        matched: serverStatus === status,
      });
    } catch (readbackError) {
      const code = (readbackError as { code?: string }).code || "unknown";
      logIncidentAction(
        "status-toggle:server-readback-nonfatal",
        { incidentId: id, nextStatus: status, code, message: (readbackError as Error).message },
        true
      );
    }

    if (status === "resolved" && responderUid) {
      const responderDocId = await resolveResponderDocIdByAuthUid(responderUid);
      const responderRef = doc(db, "responders", responderDocId);
      logIncidentAction("status-toggle:responder-update-attempt", { responderUid, responderDocId, incidentId: id });
      try {
        await withTimeout(
          updateDoc(responderRef, {
            status: "Available",
            currentIncidentId: null,
            updatedAt: serverTimestamp(),
          }),
          12000,
          "status toggle responder update"
        );
      } catch (responderUpdateError) {
        const code = (responderUpdateError as { code?: string }).code || "unknown";
        logIncidentAction(
          "status-toggle:responder-update-failed",
          { responderUid, incidentId: id, code, message: (responderUpdateError as Error).message },
          true
        );

        try {
          await withTimeout(
            patchFirestoreDocumentViaRest(
              "responders",
              responderDocId,
              {
                status: "Available",
                currentIncidentId: null,
                updatedAt: new Date(),
              },
              ["status", "currentIncidentId", "updatedAt"]
            ),
            12000,
            "status toggle responder REST fallback"
          );
          logIncidentAction("status-toggle:responder-rest-fallback-ok", { responderUid, responderDocId, incidentId: id });
        } catch (responderFallbackError) {
          const fallbackCode = (responderFallbackError as { code?: string }).code || "unknown";
          logIncidentAction(
            "status-toggle:responder-rest-fallback-failed",
            {
              responderUid,
              responderDocId,
              incidentId: id,
              fallbackCode,
              message: (responderFallbackError as Error).message,
            },
            true
          );

          throw new Error("Incident was marked resolved, but responder duty status could not be updated to Available.");
        }
      }
      logIncidentAction("status-toggle:responder-update-ok", {
        responderUid,
        responderDocId,
        responderStatus: "Available",
        currentIncidentId: null,
      });
    }
  } catch (error) {
    const code = (error as { code?: string }).code || "unknown";
    logIncidentAction("status-toggle:failed", { incidentId: id, nextStatus: status, code, message: (error as Error).message }, true);
    throw error;
  }
}

export async function markIncidentOnScene(id: string) {
  const incidentRef = doc(db, "incidents", id);
  logIncidentAction("mark-on-scene:start", { incidentId: id });

  try {
    const incidentSnap = await withTimeout(
      getDocFromServer(incidentRef),
      12000,
      "mark on-scene pre-read"
    );

    if (!incidentSnap.exists()) {
      throw new Error("Incident not found.");
    }

    const currentStatus = incidentSnap.data()?.status;
    if (currentStatus !== "en_route") {
      logIncidentAction("mark-on-scene:skip", {
        incidentId: id,
        currentStatus,
      });
      return false;
    }

    const updatePayload = {
      status: "on_scene",
      updatedAt: serverTimestamp(),
    };

    try {
      await withTimeout(updateDoc(incidentRef, updatePayload), 12000, "mark on-scene write");
    } catch (writeError) {
      if (!isTimeoutError(writeError)) {
        throw writeError;
      }

      await withTimeout(
        patchFirestoreDocumentViaRest(
          "incidents",
          id,
          {
            status: "on_scene",
            updatedAt: new Date(),
          },
          ["status", "updatedAt"]
        ),
        12000,
        "mark on-scene REST fallback"
      );
    }

    logIncidentAction("mark-on-scene:ok", {
      incidentId: id,
      nextStatus: "on_scene",
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code || "unknown";
    logIncidentAction(
      "mark-on-scene:failed",
      {
        incidentId: id,
        code,
        message: (error as Error).message,
      },
      true
    );
    throw error;
  }
}

export async function updateResponderDutyStatus(nextStatus: "Available" | "Off-Duty") {
  const responderUid = auth.currentUser?.uid;
  if (!responderUid) {
    throw new Error("You must be logged in to update responder status.");
  }

  const responderDocId = await resolveResponderDocIdByAuthUid(responderUid);
  const responderRef = doc(db, "responders", responderDocId);
  const payload: Record<string, unknown> = {
    status: nextStatus,
    updatedAt: serverTimestamp(),
  };

  if (nextStatus === "Off-Duty") {
    payload.currentIncidentId = null;
  }

  logIncidentAction("responder-duty-toggle:start", {
    responderUid,
    responderDocId,
    nextStatus,
  });

  try {
    try {
      await withTimeout(updateDoc(responderRef, payload), 12000, "responder duty toggle update");
    } catch (writeError) {
      if (!isTimeoutError(writeError)) {
        throw writeError;
      }

      const restPayload: Record<string, unknown> = {
        status: nextStatus,
        updatedAt: new Date(),
      };
      const fieldPaths = ["status", "updatedAt"];

      if (nextStatus === "Off-Duty") {
        restPayload.currentIncidentId = null;
        fieldPaths.push("currentIncidentId");
      }

      await withTimeout(
        patchFirestoreDocumentViaRest("responders", responderDocId, restPayload, fieldPaths),
        12000,
        "responder duty toggle REST fallback"
      );
      logIncidentAction("responder-duty-toggle:rest-fallback-ok", { responderUid, responderDocId, nextStatus });
    }

    logIncidentAction("responder-duty-toggle:ok", {
      responderUid,
      responderDocId,
      nextStatus,
    });
  } catch (error) {
    const code = (error as { code?: string }).code || "unknown";
    logIncidentAction(
      "responder-duty-toggle:failed",
      { responderUid, responderDocId, nextStatus, code, message: (error as Error).message },
      true
    );
    throw error;
  }
}

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const crypto = require("node:crypto");
const admin = require("firebase-admin");

const { sendSmsMobileApi, fetchSmsMobileInbox } = require("./smsmobileapi");

// smsmobileapi migration constants
const SMSMOBILEAPI_API_KEY = "8e82949f466e58ed578ff58a38038bc0b82881aaefb85540";
const SMSMOBILEAPI_DESTINATION = "+639177044103";
const simInboundTokenSecret = defineSecret("SIM_INBOUND_TOKEN");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = admin.firestore();

function isIncidentCategory(value) {
  return value === "fire" || value === "medical" || value === "crime" || value === "disaster";
}

function parseInboundSmsPayload(payload) {
  const sender =
    (typeof payload?.From === "string" && payload.From.trim()) ||
    (typeof payload?.from === "string" && payload.from.trim()) ||
    (typeof payload?.sender === "string" && payload.sender.trim()) ||
    (typeof payload?.number === "string" && payload.number.trim()) ||
    "Unknown sender";

  const message =
    (typeof payload?.Body === "string" && payload.Body.trim()) ||
    (typeof payload?.body === "string" && payload.body.trim()) ||
    (typeof payload?.message === "string" && payload.message.trim()) ||
    (typeof payload?.text === "string" && payload.text.trim()) ||
    "";

  return { sender, message };
}

async function storeInboundSms({ sender, message, source, extra = {} }) {
  const forcedSmsId = typeof extra.forcedSmsId === "string" ? extra.forcedSmsId.trim() : "";
  const { forcedSmsId: _ignoredForcedSmsId, ...extraPayload } = extra;

  const basePayload = {
    sender,
    phone: sender,
    from: sender,
    message,
    body: message,
    source,
    converted: false,
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extraPayload,
  };

  const smsId = forcedSmsId || db.collection("incoming_sms").doc().id;
  const incomingRef = db.collection("incoming_sms").doc(smsId);
  const smsInboxRef = db.collection("smsInbox").doc(smsId);

  await Promise.all([
    incomingRef.set(basePayload, { merge: true }),
    smsInboxRef.set(basePayload, { merge: true }),
  ]);

  return {
    smsId,
    incomingRef,
    smsInboxRef,
  };
}

function toTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeTokenEquals(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function extractBearerToken(headerValue) {
  if (typeof headerValue !== "string") {
    return "";
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match && typeof match[1] === "string" ? match[1].trim() : "";
}

function extractInboundBridgeToken(req, payload) {
  const headerToken =
    toTrimmedString(req.get("x-bridge-token")) ||
    toTrimmedString(req.get("x-webhook-token")) ||
    toTrimmedString(req.get("x-api-key"));

  if (headerToken) {
    return headerToken;
  }

  const bearerToken = extractBearerToken(req.get("authorization"));
  if (bearerToken) {
    return bearerToken;
  }

  return (
    toTrimmedString(payload?.token) ||
    toTrimmedString(payload?.apiKey) ||
    toTrimmedString(payload?.secret)
  );
}

function toDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (value && typeof value === "object" && typeof value.toDate === "function") {
    try {
      const dateValue = value.toDate();
      if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
        return dateValue;
      }
    } catch {
      // Ignore invalid timestamp-like objects.
    }
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function extractLabeledSmsValue(message, label) {
  const matcher = new RegExp(`(?:^|\\||\\n)\\s*${label}\\s*:\\s*([^|\\n]+)`, "i");
  const match = message.match(matcher);
  if (!match || typeof match[1] !== "string") {
    return null;
  }

  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function normalizeIncidentCategory(value) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "fire") return "fire";
  if (normalized === "medical") return "medical";
  if (normalized === "crime" || normalized === "police") return "crime";
  if (normalized === "disaster") return "disaster";
  return null;
}

function inferIncidentCategoryFromSmsMessage(message) {
  const content = message.toLowerCase();
  if (content.includes("sunog") || content.includes("fire")) return "fire";
  if (
    content.includes("baha") ||
    content.includes("flood") ||
    content.includes("landslide") ||
    content.includes("bagyo") ||
    content.includes("storm")
  ) {
    return "disaster";
  }
  if (
    content.includes("injured") ||
    content.includes("sugat") ||
    content.includes("nahimatay") ||
    content.includes("collapsed") ||
    content.includes("medical")
  ) {
    return "medical";
  }
  return "crime";
}

function inferIncidentPriorityFromSmsMessage(message, category) {
  const content = message.toLowerCase();
  if (
    content.includes("critical") ||
    content.includes("urgent") ||
    content.includes("malaki") ||
    content.includes("malala") ||
    content.includes("major") ||
    content.includes("multiple")
  ) {
    return "Critical";
  }

  if (
    content.includes("help") ||
    content.includes("tulong") ||
    content.includes("emergency") ||
    content.includes("aksidente") ||
    content.includes("accident")
  ) {
    return "High";
  }

  if (category === "fire" || category === "medical") {
    return "Critical";
  }

  if (category === "crime" || category === "disaster") {
    return "High";
  }

  return "Low";
}

function parseCoordinatesFromSmsMessage(message) {
  const coordsLine = extractLabeledSmsValue(message, "COORDS");
  if (!coordsLine) {
    return null;
  }

  const match = coordsLine.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

function normalizeCoordinates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const latRaw = value.lat;
  const lngRaw = value.lng;
  const lat = typeof latRaw === "number" ? latRaw : Number(latRaw);
  const lng = typeof lngRaw === "number" ? lngRaw : Number(lngRaw);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

function categoryLabel(category) {
  if (category === "fire") return "Fire";
  if (category === "medical") return "Medical";
  if (category === "crime") return "Crime";
  return "Disaster";
}

function buildIncidentTitleFromSms(category, message) {
  const label = categoryLabel(category);
  const trimmed = message.trim();
  if (!trimmed) {
    return `${label} Incident via SMS`;
  }

  const snippet = trimmed.length > 64 ? `${trimmed.slice(0, 61)}...` : trimmed;
  return `${label}: ${snippet}`;
}

function buildIncidentFromInboundSms({ smsId, data }) {
  const sender =
    toTrimmedString(data.sender) ||
    toTrimmedString(data.phone) ||
    toTrimmedString(data.from) ||
    "Unknown Sender";
  const message =
    toTrimmedString(data.message) ||
    toTrimmedString(data.body) ||
    toTrimmedString(data.text) ||
    "No SMS body received.";

  const labeledCategory = normalizeIncidentCategory(extractLabeledSmsValue(message, "CATEGORY"));
  const category =
    normalizeIncidentCategory(data.category) ||
    labeledCategory ||
    inferIncidentCategoryFromSmsMessage(message);
  const priority = inferIncidentPriorityFromSmsMessage(message, category);
  const location =
    toTrimmedString(data.location) ||
    extractLabeledSmsValue(message, "LOCATION") ||
    "Reported via SMS";
  const coordinates =
    normalizeCoordinates(data.coordinates) ||
    parseCoordinatesFromSmsMessage(message);
  const description =
    toTrimmedString(data.description) ||
    extractLabeledSmsValue(message, "DESCRIPTION") ||
    message;

  const residentName =
    toTrimmedString(data.residentName) ||
    toTrimmedString(data.reporterName) ||
    sender ||
    "SMS Reporter";
  const residentEmailRaw =
    toTrimmedString(data.residentEmail) ||
    toTrimmedString(data.reporterEmail);
  const residentEmail = residentEmailRaw
    ? residentEmailRaw.toLowerCase()
    : (sender.includes("@") ? sender.toLowerCase() : "");
  const residentPhone =
    toTrimmedString(data.residentPhone) ||
    toTrimmedString(data.reporterPhone) ||
    (!sender.includes("@") ? sender : "");

  const reportId = toTrimmedString(data.reportId);
  const residentUid =
    toTrimmedString(data.residentUid) ||
    toTrimmedString(data.residentId) ||
    (reportId ? `sms:${reportId}` : `sms:${smsId}`);

  const reportedAt =
    toDateValue(data.originalCreatedAtIso) ||
    toDateValue(data.createdAtIso) ||
    toDateValue(data.receivedAt) ||
    toDateValue(data.createdAt) ||
    new Date();

  return {
    title: buildIncidentTitleFromSms(category, message),
    category,
    description,
    location,
    barangay: toTrimmedString(data.barangay) || "Unknown",
    priority,
    status: "pending",
    source: "SMS",
    lat: coordinates ? coordinates.lat : 0,
    lng: coordinates ? coordinates.lng : 0,
    assignedResponders: [],
    residentId: residentUid,
    residentName,
    residentEmail,
    residentPhone,
    photoUrl: null,
    reportedAt: admin.firestore.Timestamp.fromDate(reportedAt),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    smsReportId: smsId,
    smsSourceCollection: "incoming_sms",
    smsSender: sender,
    smsProvider: toTrimmedString(data.provider) || null,
    smsOriginalReportId: reportId || null,
  };
}

function sanitizeDocIdSegment(value) {
  const normalized = toTrimmedString(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 80);
}

function buildGatewaySmsDocId(provider, gatewayMessageId) {
  const providerPart = sanitizeDocIdSegment(provider) || "gateway";
  const messagePart = sanitizeDocIdSegment(gatewayMessageId);
  if (!messagePart) {
    return null;
  }
  return `gateway-${providerPart}-${messagePart}`;
}

function normalizeSmsMobileInboxItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidateLists = [
    payload.messages,
    payload.items,
    payload.data,
    payload.results,
    payload.inbox,
  ];

  for (const candidate of candidateLists) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function parseSmsMobileInboxItem(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const sender =
    toTrimmedString(row.from) ||
    toTrimmedString(row.sender) ||
    toTrimmedString(row.number) ||
    toTrimmedString(row.phone) ||
    "Unknown sender";
  const message =
    toTrimmedString(row.message) ||
    toTrimmedString(row.body) ||
    toTrimmedString(row.text) ||
    toTrimmedString(row.content);

  if (!message) {
    return null;
  }

  const gatewayMessageId =
    toTrimmedString(row.message_id) ||
    toTrimmedString(row.messageId) ||
    toTrimmedString(row.smsId) ||
    toTrimmedString(row.id) ||
    null;
  const gatewayReceivedAt =
    toTrimmedString(row.receivedAt) ||
    toTrimmedString(row.timestamp) ||
    toTrimmedString(row.date) ||
    null;

  return {
    sender,
    message,
    gatewayMessageId,
    gatewayReceivedAt,
  };
}

function parseSmsFallbackPayload(data) {
  const reportId = typeof data?.reportId === "string" ? data.reportId.trim() : "";
  const smsBody = typeof data?.smsBody === "string" ? data.smsBody.trim() : "";
  const category = typeof data?.category === "string" ? data.category.trim().toLowerCase() : "";
  const location = typeof data?.location === "string" ? data.location.trim() : "";
  const description = typeof data?.description === "string" ? data.description.trim() : "";
  const createdAtIso = typeof data?.createdAtIso === "string" ? data.createdAtIso.trim() : "";
  const reporterName = typeof data?.reporterName === "string" ? data.reporterName.trim() : "";
  const reporterPhone = typeof data?.reporterPhone === "string" ? data.reporterPhone.trim() : "";
  const reporterEmail = typeof data?.reporterEmail === "string" ? data.reporterEmail.trim() : "";
  const coordinatesData =
    data?.coordinates && typeof data.coordinates === "object" && !Array.isArray(data.coordinates)
      ? data.coordinates
      : null;
  const lat = typeof coordinatesData?.lat === "number" && Number.isFinite(coordinatesData.lat) ? coordinatesData.lat : null;
  const lng = typeof coordinatesData?.lng === "number" && Number.isFinite(coordinatesData.lng) ? coordinatesData.lng : null;

  if (!smsBody) {
    throw new HttpsError("invalid-argument", "smsBody is required.");
  }

  if (smsBody.length > 3000) {
    throw new HttpsError("invalid-argument", "smsBody is too long.");
  }

  if (!category || !isIncidentCategory(category)) {
    throw new HttpsError("invalid-argument", "A valid category is required.");
  }

  if (!location) {
    throw new HttpsError("invalid-argument", "Location is required.");
  }

  return {
    reportId: reportId || null,
    smsBody,
    category,
    location,
    description,
    createdAtIso: createdAtIso || null,
    reporterName: reporterName || null,
    reporterPhone: reporterPhone || null,
    reporterEmail: reporterEmail || null,
    coordinates: lat !== null && lng !== null ? { lat, lng } : null,
  };
}

async function assertResidentCaller(request) {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const residentSnap = await db.collection("residents").doc(callerUid).get();
  if (!residentSnap.exists) {
    throw new HttpsError("permission-denied", "Only resident accounts can use SMS fallback.");
  }

  const residentData = residentSnap.data() || {};
  const approved = residentData.verified === true || residentData.verificationStatus === "approved";
  if (!approved) {
    throw new HttpsError("permission-denied", "Resident account must be approved to send reports.");
  }

  return {
    uid: callerUid,
    name:
      (typeof residentData.fullName === "string" && residentData.fullName.trim()) ||
      (typeof residentData.name === "string" && residentData.name.trim()) ||
      null,
    email: typeof residentData.email === "string" && residentData.email.trim()
      ? residentData.email.trim().toLowerCase()
      : null,
    phone: typeof residentData.phone === "string" && residentData.phone.trim()
      ? residentData.phone.trim()
      : null,
  };
}


// No-op: readSemaphoreConfig removed for smsmobileapi migration

function readSimInboundToken() {
  let token = "";

  try {
    const secretValue = simInboundTokenSecret.value();
    if (typeof secretValue === "string") {
      token = secretValue.trim();
    }
  } catch {
    token = "";
  }

  if (!token && typeof process.env.SIM_INBOUND_TOKEN === "string") {
    token = process.env.SIM_INBOUND_TOKEN.trim();
  }

  if (!token) {
    throw new Error("SIM_INBOUND_TOKEN is not configured in Cloud Functions.");
  }

  return token;
}


// sendSmsSemaphore removed for smsmobileapi migration

async function assertAdminCaller(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const adminSnap = await db.collection("admins").doc(request.auth.uid).get();
  if (!adminSnap.exists) {
    throw new HttpsError("permission-denied", "Only admins can perform this action.");
  }
}

exports.syncSmsMobileInbox = onCall(async (request) => {
  await assertAdminCaller(request);

  const requestedLimit =
    typeof request.data?.limit === "number" && Number.isFinite(request.data.limit)
      ? request.data.limit
      : 50;
  const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit)));

  const inboxPayload = await fetchSmsMobileInbox({
    apiKey: SMSMOBILEAPI_API_KEY,
    limit,
  });
  const inboxRows = normalizeSmsMobileInboxItems(inboxPayload);

  let ingested = 0;
  let skipped = 0;

  for (const row of inboxRows) {
    const parsed = parseSmsMobileInboxItem(row);
    if (!parsed) {
      skipped += 1;
      continue;
    }

    const forcedSmsId = parsed.gatewayMessageId
      ? buildGatewaySmsDocId("smsmobileapi", parsed.gatewayMessageId)
      : null;

    if (forcedSmsId) {
      const existing = await db.collection("incoming_sms").doc(forcedSmsId).get();
      if (existing.exists) {
        skipped += 1;
        continue;
      }
    }

    await storeInboundSms({
      sender: parsed.sender,
      message: parsed.message,
      source: "smsmobileapi",
      extra: {
        provider: "smsmobileapi",
        gatewayMessageId: parsed.gatewayMessageId,
        gatewayReceivedAt: parsed.gatewayReceivedAt,
        ...(forcedSmsId ? { forcedSmsId } : {}),
      },
    });
    ingested += 1;
  }

  return {
    ok: true,
    provider: "smsmobileapi",
    fetched: inboxRows.length,
    ingested,
    skipped,
  };
});

function parsePayload(data) {
  const uid = typeof data?.uid === "string" ? data.uid.trim() : "";
  const responderDocId = typeof data?.responderDocId === "string" ? data.responderDocId.trim() : "";

  if (!uid) {
    throw new HttpsError("invalid-argument", "Responder UID is required.");
  }

  return {
    uid,
    responderDocId: responderDocId || uid,
  };
}

exports.deleteResponderAccount = onCall(async (request) => {
  await assertAdminCaller(request);
  const { uid: requestedUid, responderDocId } = parsePayload(request.data);

  let responderEmail = null;
  let resolvedResponderDocId = responderDocId;
  let targetUid = requestedUid;
  let responderProfile = null;

  const primarySnap = await db.collection("responders").doc(responderDocId).get();
  if (primarySnap.exists) {
    responderProfile = primarySnap.data() || null;
  } else if (responderDocId !== requestedUid) {
    const fallbackSnap = await db.collection("responders").doc(requestedUid).get();
    if (fallbackSnap.exists) {
      resolvedResponderDocId = requestedUid;
      responderProfile = fallbackSnap.data() || null;
    }
  }

  if (!responderProfile) {
    throw new HttpsError("not-found", "Responder profile not found.");
  }

  if (responderProfile.role !== "responder") {
    throw new HttpsError("failed-precondition", "The selected account is not a responder.");
  }

  const profileUid =
    typeof responderProfile.uid === "string" && responderProfile.uid.trim()
      ? responderProfile.uid.trim()
      : resolvedResponderDocId;

  if (profileUid !== requestedUid) {
    throw new HttpsError("invalid-argument", "Responder UID mismatch.");
  }

  targetUid = profileUid;

  if (typeof responderProfile.email === "string" && responderProfile.email.trim()) {
    responderEmail = responderProfile.email.trim().toLowerCase();
  }

  let authDeleted = false;
  try {
    await admin.auth().deleteUser(targetUid);
    authDeleted = true;
  } catch (error) {
    const code = error && typeof error.code === "string" ? error.code : "";
    if (code !== "auth/user-not-found") {
      logger.error("Failed to delete responder auth user", {
        uid: targetUid,
        code,
        message: error?.message,
      });
      throw new HttpsError("internal", "Unable to delete responder auth account.");
    }
  }

  const incidentsSnap = await db
    .collection("incidents")
    .where("assignedResponders", "array-contains", targetUid)
    .get();

  const updatePromises = incidentsSnap.docs.map((incidentDoc) => {
    const payload = {
      assignedResponders: admin.firestore.FieldValue.arrayRemove(targetUid),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (responderEmail) {
      payload.assignedResponderEmails = admin.firestore.FieldValue.arrayRemove(responderEmail);
    }

    return incidentDoc.ref.update(payload).catch((error) => {
      logger.error("Failed to detach responder from incident", {
        uid: targetUid,
        incidentId: incidentDoc.id,
        message: error?.message,
      });
      throw error;
    });
  });

  await Promise.all(updatePromises);

  const cleanupTargets = [
    db.collection("responders").doc(resolvedResponderDocId).delete().catch(() => undefined),
    db.collection("responderLiveLocations").doc(targetUid).delete().catch(() => undefined),
  ];

  if (resolvedResponderDocId !== targetUid) {
    cleanupTargets.push(db.collection("responders").doc(targetUid).delete().catch(() => undefined));
  }

  await Promise.all(cleanupTargets);

  return {
    ok: true,
    authDeleted,
    incidentsUpdated: incidentsSnap.size,
  };
});

function parseResidentPayload(data) {
  const uid = typeof data?.uid === "string" ? data.uid.trim() : "";
  const residentDocId = typeof data?.residentDocId === "string" ? data.residentDocId.trim() : "";

  if (!uid && !residentDocId) {
    throw new HttpsError("invalid-argument", "Resident UID or residentDocId is required.");
  }

  return {
    uid: uid || residentDocId,
    residentDocId: residentDocId || uid,
  };
}

exports.deleteResidentAccount = onCall(async (request) => {
  await assertAdminCaller(request);
  const { uid: requestedUid, residentDocId } = parseResidentPayload(request.data);

  let resolvedResidentDocId = residentDocId;
  let targetUid = requestedUid;
  let residentProfile = null;

  const primarySnap = await db.collection("residents").doc(residentDocId).get();
  if (primarySnap.exists) {
    residentProfile = primarySnap.data() || null;
  } else if (residentDocId !== requestedUid) {
    const fallbackSnap = await db.collection("residents").doc(requestedUid).get();
    if (fallbackSnap.exists) {
      resolvedResidentDocId = requestedUid;
      residentProfile = fallbackSnap.data() || null;
    }
  }

  if (!residentProfile) {
    throw new HttpsError("not-found", "Resident profile not found.");
  }

  if (residentProfile.role !== "resident") {
    throw new HttpsError("failed-precondition", "The selected account is not a resident.");
  }

  const profileUid =
    typeof residentProfile.uid === "string" && residentProfile.uid.trim()
      ? residentProfile.uid.trim()
      : resolvedResidentDocId;

  targetUid = profileUid;

  let authDeleted = false;
  try {
    await admin.auth().deleteUser(targetUid);
    authDeleted = true;
  } catch (error) {
    const code = error && typeof error.code === "string" ? error.code : "";
    if (code !== "auth/user-not-found") {
      logger.error("Failed to delete resident auth user", {
        uid: targetUid,
        code,
        message: error?.message,
      });
      throw new HttpsError("internal", "Unable to delete resident auth account.");
    }
  }

  await Promise.all([
    db.collection("residents").doc(resolvedResidentDocId).delete().catch(() => undefined),
    resolvedResidentDocId !== targetUid
      ? db.collection("residents").doc(targetUid).delete().catch(() => undefined)
      : Promise.resolve(),
  ]);

  return {
    ok: true,
    authDeleted,
  };
});

exports.submitSmsFallbackReport = onCall(async (request) => {
  const resident = await assertResidentCaller(request);
  const payload = parseSmsFallbackPayload(request.data);

  try {
    const smsmobileResponse = await sendSmsMobileApi({
      apiKey: SMSMOBILEAPI_API_KEY,
      destination: SMSMOBILEAPI_DESTINATION,
      message: payload.smsBody,
    });

    const senderIdentity = payload.reporterPhone || resident.phone || payload.reporterEmail || resident.email || resident.uid;

    await storeInboundSms({
      sender: senderIdentity,
      message: payload.smsBody,
      source: "smsmobileapi",
      extra: {
        provider: "smsmobileapi",
        reportId: payload.reportId,
        residentUid: resident.uid,
        residentName: payload.reporterName || resident.name || "Resident",
        category: payload.category,
        location: payload.location,
        description: payload.description || "",
        coordinates: payload.coordinates,
        originalCreatedAtIso: payload.createdAtIso,
        smsmobileResponse,
      },
    });

    return {
      ok: true,
      destination: SMSMOBILEAPI_DESTINATION,
      provider: "smsmobileapi",
      smsmobileResponse,
    };
  } catch (error) {
    logger.error("Failed to send SMS fallback via smsmobileapi", {
      uid: request.auth?.uid || null,
      reportId: payload.reportId,
      message: error?.message,
    });
    throw new HttpsError("internal", "Unable to send SMS fallback via smsmobileapi.");
  }
});

exports.twilioInboundSms = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    let payload = req.body;
    if (!payload || typeof payload !== "object") {
      const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : "";
      payload = Object.fromEntries(new URLSearchParams(raw));
    }

    const { sender, message } = parseInboundSmsPayload(payload);

    await storeInboundSms({
      sender,
      message,
      source: "twilio",
      extra: {
        provider: "twilio",
      },
    });

    // Twilio expects valid XML response.
    res.set("Content-Type", "text/xml");
    res.status(200).send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  } catch (error) {
    logger.error("Failed to process Twilio inbound SMS", {
      message: error?.message,
    });
    res.status(500).send("Internal Server Error");
  }
});

exports.semaphoreInboundSms = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    let payload = req.body;
    if (!payload || typeof payload !== "object") {
      const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : "";
      payload = Object.fromEntries(new URLSearchParams(raw));
    }

    const { sender, message } = parseInboundSmsPayload(payload);

    await storeInboundSms({
      sender,
      message,
      source: "semaphore",
      extra: {
        provider: "semaphore",
      },
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error("Failed to process Semaphore inbound SMS", {
      message: error?.message,
    });
    res.status(500).json({ ok: false });
  }
});

exports.smsmobileapiInboundSms = onRequest({
  secrets: [simInboundTokenSecret],
}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    let payload = req.body;
    if (!payload || typeof payload !== "object") {
      const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : "";
      payload = Object.fromEntries(new URLSearchParams(raw));
    }

    const expectedToken = readSimInboundToken();
    const providedToken = extractInboundBridgeToken(req, payload);
    if (!safeTokenEquals(providedToken, expectedToken)) {
      logger.warn("Rejected smsmobileapi inbound SMS due to invalid token", {
        senderHint:
          (typeof payload?.From === "string" && payload.From.trim()) ||
          (typeof payload?.from === "string" && payload.from.trim()) ||
          (typeof payload?.sender === "string" && payload.sender.trim()) ||
          (typeof payload?.number === "string" && payload.number.trim()) ||
          null,
      });
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const { sender, message } = parseInboundSmsPayload(payload);

    await storeInboundSms({
      sender,
      message,
      source: "smsmobileapi",
      extra: {
        provider: "smsmobileapi",
        gatewayMessageId:
          toTrimmedString(payload?.messageId) ||
          toTrimmedString(payload?.smsId) ||
          toTrimmedString(payload?.id) ||
          null,
        gatewayReceivedAt:
          toTrimmedString(payload?.receivedAt) ||
          toTrimmedString(payload?.timestamp) ||
          toTrimmedString(payload?.date) ||
          null,
      },
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error("Failed to process smsmobileapi inbound SMS", {
      message: error?.message,
    });
    res.status(500).json({ ok: false });
  }
});

exports.simInboundSms = onRequest({
  secrets: [simInboundTokenSecret],
}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    let payload = req.body;
    if (!payload || typeof payload !== "object") {
      const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : "";
      payload = Object.fromEntries(new URLSearchParams(raw));
    }

    const expectedToken = readSimInboundToken();
    const providedToken = extractInboundBridgeToken(req, payload);
    if (!safeTokenEquals(providedToken, expectedToken)) {
      logger.warn("Rejected SIM bridge inbound SMS due to invalid token", {
        senderHint:
          (typeof payload?.From === "string" && payload.From.trim()) ||
          (typeof payload?.from === "string" && payload.from.trim()) ||
          (typeof payload?.sender === "string" && payload.sender.trim()) ||
          null,
      });
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const { sender, message } = parseInboundSmsPayload(payload);

    await storeInboundSms({
      sender,
      message,
      source: "sim-bridge",
      extra: {
        provider: "sim-bridge",
        bridgeMessageId:
          toTrimmedString(payload?.messageId) ||
          toTrimmedString(payload?.smsId) ||
          toTrimmedString(payload?.id) ||
          null,
        bridgeReceivedAt:
          toTrimmedString(payload?.receivedAt) ||
          toTrimmedString(payload?.timestamp) ||
          toTrimmedString(payload?.date) ||
          null,
      },
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error("Failed to process SIM bridge inbound SMS", {
      message: error?.message,
    });
    res.status(500).json({ ok: false });
  }
});

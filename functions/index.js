const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const SEMAPHORE_MESSAGES_ENDPOINT = "https://api.semaphore.co/api/v4/messages";
const DEFAULT_SEMAPHORE_SENDERNAME = "MDRRMO";
const semaphoreApiKeySecret = defineSecret("SEMAPHORE_API_KEY");
const smsFallbackNumberSecret = defineSecret("SMS_FALLBACK_NUMBER");

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
    ...extra,
  };

  await Promise.all([
    db.collection("incoming_sms").add(basePayload),
    db.collection("smsInbox").add(basePayload),
  ]);
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

function readSemaphoreConfig() {
  let apiKey = "";
  let destination = "";

  try {
    const secretValue = semaphoreApiKeySecret.value();
    if (typeof secretValue === "string") {
      apiKey = secretValue.trim();
    }
  } catch {
    apiKey = "";
  }

  try {
    const secretValue = smsFallbackNumberSecret.value();
    if (typeof secretValue === "string") {
      destination = secretValue.trim();
    }
  } catch {
    destination = "";
  }

  if (!apiKey && typeof process.env.SEMAPHORE_API_KEY === "string") {
    apiKey = process.env.SEMAPHORE_API_KEY.trim();
  }

  if (!destination && typeof process.env.SMS_FALLBACK_NUMBER === "string") {
    destination = process.env.SMS_FALLBACK_NUMBER.trim();
  }

  const senderNameRaw =
    typeof process.env.SEMAPHORE_SENDERNAME === "string"
      ? process.env.SEMAPHORE_SENDERNAME.trim()
      : "";

  if (!apiKey) {
    throw new HttpsError(
      "failed-precondition",
      "SEMAPHORE_API_KEY is not configured in Cloud Functions."
    );
  }

  if (!destination) {
    throw new HttpsError(
      "failed-precondition",
      "SMS_FALLBACK_NUMBER is not configured in Cloud Functions."
    );
  }

  return {
    apiKey,
    destination,
    senderName: senderNameRaw || DEFAULT_SEMAPHORE_SENDERNAME,
  };
}

async function sendSmsSemaphore({ apiKey, destination, message, senderName }) {
  const payload = new URLSearchParams();
  payload.set("apikey", apiKey);
  payload.set("number", destination);
  payload.set("message", message);
  if (senderName) {
    payload.set("sendername", senderName);
  }

  const response = await fetch(SEMAPHORE_MESSAGES_ENDPOINT, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
  });

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new Error(
      `Semaphore API request failed with status ${response.status}: ${JSON.stringify(responseBody)}`
    );
  }

  if (!Array.isArray(responseBody)) {
    throw new Error("Semaphore API response was not an array.");
  }

  return responseBody;
}

async function assertAdminCaller(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const adminSnap = await db.collection("admins").doc(request.auth.uid).get();
  if (!adminSnap.exists) {
    throw new HttpsError("permission-denied", "Only admins can perform this action.");
  }
}

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

exports.submitSmsFallbackReport = onCall({
  secrets: [semaphoreApiKeySecret, smsFallbackNumberSecret],
}, async (request) => {
  const resident = await assertResidentCaller(request);
  const payload = parseSmsFallbackPayload(request.data);
  const semaphoreConfig = readSemaphoreConfig();

  try {
    const semaphoreResponse = await sendSmsSemaphore({
      apiKey: semaphoreConfig.apiKey,
      destination: semaphoreConfig.destination,
      message: payload.smsBody,
      senderName: semaphoreConfig.senderName,
    });

    const semaphoreMessageIds = semaphoreResponse
      .map((row) => {
        const idValue = row && typeof row === "object" ? row.message_id : null;
        if (typeof idValue === "number" || typeof idValue === "string") {
          return String(idValue);
        }
        return null;
      })
      .filter((value) => typeof value === "string");

    const senderIdentity = payload.reporterPhone || resident.phone || payload.reporterEmail || resident.email || resident.uid;

    await storeInboundSms({
      sender: senderIdentity,
      message: payload.smsBody,
      source: "semaphore",
      extra: {
        provider: "semaphore",
        reportId: payload.reportId,
        residentUid: resident.uid,
        residentName: payload.reporterName || resident.name || "Resident",
        category: payload.category,
        location: payload.location,
        description: payload.description || "",
        coordinates: payload.coordinates,
        originalCreatedAtIso: payload.createdAtIso,
        semaphoreMessageIds,
      },
    });

    return {
      ok: true,
      destination: semaphoreConfig.destination,
      provider: "semaphore",
      semaphoreMessageIds,
    };
  } catch (error) {
    logger.error("Failed to send SMS fallback via Semaphore", {
      uid: request.auth?.uid || null,
      reportId: payload.reportId,
      message: error?.message,
    });
    throw new HttpsError("internal", "Unable to send SMS fallback via Semaphore.");
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

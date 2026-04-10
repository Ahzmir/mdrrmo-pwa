const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = admin.firestore();

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

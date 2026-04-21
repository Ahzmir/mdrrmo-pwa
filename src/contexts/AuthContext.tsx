import { createContext, useContext, useState, useCallback, ReactNode, useEffect } from "react";
import { FirebaseError } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db, ensureAuthPersistence } from "@/lib/firebase";

export type UserRole = "resident" | "responder";
export type ResponderUnit = "police" | "medic" | "disaster";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  responderUnit?: ResponderUnit;
}

export interface ResidentRegistrationInput {
  fullName: string;
  email: string;
  password: string;
  phone: string;
  address: string;
  barangay: string;
  city: string;
  idType: string;
  idNumber: string;
  validIdUrl: string;
  residencyProofUrl: string;
}

interface ResidentProfileDoc {
  fullName?: string;
  name?: string;
  email?: string;
  verified?: boolean;
  verificationStatus?: "pending" | "approved" | "rejected";
  rejectionReason?: string | null;
}

interface ResponderProfileDoc {
  role?: string;
  name?: string;
  email?: string;
  type?: string;
  responderType?: string;
  unit?: string;
  team?: string;
  department?: string;
  specialization?: string;
}

function toResponderUnit(value: unknown): ResponderUnit | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("police") || normalized.includes("crime") || normalized.includes("law")) {
    return "police";
  }

  if (normalized.includes("medic") || normalized.includes("medical") || normalized.includes("health")) {
    return "medic";
  }

  if (
    normalized.includes("disaster") ||
    normalized.includes("rescue") ||
    normalized.includes("emergency") ||
    normalized.includes("fire")
  ) {
    return "disaster";
  }

  return undefined;
}

function inferResponderUnit(profile: ResponderProfileDoc): ResponderUnit | undefined {
  return (
    toResponderUnit(profile.type) ||
    toResponderUnit(profile.responderType) ||
    toResponderUnit(profile.unit) ||
    toResponderUnit(profile.team) ||
    toResponderUnit(profile.department) ||
    toResponderUnit(profile.specialization)
  );
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  registerResident: (data: ResidentRegistrationInput) => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);
export const RESIDENT_REJECTED_KEY = "mdrrmo_resident_rejected";
export const RESIDENT_REJECTION_REASON_KEY = "mdrrmo_resident_rejection_reason";
const AUTH_CACHE_KEY = "mdrrmo_auth_user_cache_v1";

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.email === "string" &&
    (row.role === "resident" || row.role === "responder")
  );
}

function readCachedAuthUser(uid: string): AuthUser | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(AUTH_CACHE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isAuthUser(parsed)) {
      return null;
    }

    return parsed.id === uid ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedAuthUser(user: AuthUser | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!user) {
    window.localStorage.removeItem(AUTH_CACHE_KEY);
    return;
  }

  window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(user));
}

function mapAuthError(error: unknown) {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case "auth/invalid-email":
        return "Please enter a valid email address.";
      case "auth/email-already-in-use":
        return "This email is already registered. Please sign in instead.";
      case "auth/operation-not-allowed":
        return "Email/password sign-in is not enabled in Firebase Authentication yet.";
      case "auth/invalid-api-key":
        return "Firebase API key is invalid. Check your VITE_FIREBASE_* environment values.";
      case "auth/app-not-authorized":
        return "This app is not authorized for this Firebase project. Verify your Auth domain and app config.";
      case "auth/user-disabled":
        return "This account has been disabled. Please contact support.";
      case "auth/invalid-credential":
      case "auth/invalid-login-credentials":
      case "auth/user-not-found":
      case "auth/wrong-password":
        return "Invalid email or password.";
      case "auth/network-request-failed":
        return "Network error while signing in. Check your internet connection and try again.";
      case "auth/too-many-requests":
        return "Too many attempts. Please wait a moment and try again.";
      case "permission-denied":
        return "Permission denied. Check your Firebase security rules.";
      default:
        return error.message || "Authentication failed.";
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

function toResidentUser(uid: string, profile: ResidentProfileDoc, fallbackEmail: string | null): AuthUser {
  return {
    id: uid,
    name: profile.fullName || profile.name || "Resident",
    email: profile.email || fallbackEmail || "",
    role: "resident",
  };
}

function toResponderUser(uid: string, profile: ResponderProfileDoc, fallbackEmail: string | null): AuthUser {
  return {
    id: uid,
    name: profile.name || "Responder",
    email: profile.email || fallbackEmail || "",
    role: "responder",
    responderUnit: inferResponderUnit(profile),
  };
}

function isRejectedResident(profile: ResidentProfileDoc | null) {
  return profile?.verificationStatus === "rejected";
}

async function getResidentProfile(uid: string) {
  const residentRef = doc(db, "residents", uid);
  const residentSnap = await getDoc(residentRef);

  if (!residentSnap.exists()) {
    return null;
  }

  return residentSnap.data() as ResidentProfileDoc;
}

async function getResponderProfile(uid: string) {
  const responderRef = doc(db, "responders", uid);
  const responderSnap = await getDoc(responderRef);

  if (!responderSnap.exists()) {
    return null;
  }

  return responderSnap.data() as ResponderProfileDoc;
}

async function startResponderSession(uid: string) {
  const responderRef = doc(db, "responders", uid);
  await updateDoc(responderRef, {
    sessionActive: true,
    sessionStartedAt: serverTimestamp(),
    sessionEndedAt: null,
    sessionLastSeenAt: serverTimestamp(),
    lastLoginAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

async function touchResponderSession(uid: string) {
  const responderRef = doc(db, "responders", uid);
  await updateDoc(responderRef, {
    sessionActive: true,
    sessionLastSeenAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

async function updateResponderLiveLocation(
  uid: string,
  latitude: number,
  longitude: number,
  accuracy: number | null
) {
  const liveLocationPayload = {
    latitude,
    longitude,
    lat: latitude,
    lng: longitude,
    accuracy,
  };

  const responderLocationRef = doc(db, "responderLiveLocations", uid);
  const responderRef = doc(db, "responders", uid);

  const liveCollectionWrite = setDoc(responderLocationRef, {
    uid,
    liveLocation: liveLocationPayload,
    liveLocationUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });

  const responderDocWrite = updateDoc(responderRef, {
    sessionActive: true,
    sessionLastSeenAt: serverTimestamp(),
    liveLocation: liveLocationPayload,
    liveLocationUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await Promise.allSettled([liveCollectionWrite, responderDocWrite]);
}

async function updateResidentLiveLocation(
  uid: string,
  latitude: number,
  longitude: number,
  accuracy: number | null
) {
  const residentRef = doc(db, "residents", uid);
  await updateDoc(residentRef, {
    liveLocation: {
      latitude,
      longitude,
      accuracy,
    },
    liveLocationUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

function getDistanceMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
) {
  const earthRadius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;

  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);
  const lat1 = toRad(fromLat);
  const lat2 = toRad(toLat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadius * c;
}

async function endResponderSession(uid: string) {
  const responderRef = doc(db, "responders", uid);
  await updateDoc(responderRef, {
    sessionActive: false,
    sessionEndedAt: serverTimestamp(),
    sessionLastSeenAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

async function captureCurrentPosition() {
  if (typeof window === "undefined" || !navigator.geolocation) {
    return null;
  }

  return new Promise<{ lat: number; lng: number; accuracy: number | null } | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null;
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy,
        });
      },
      () => resolve(null),
      {
        enableHighAccuracy: true,
        timeout: 2000,
        maximumAge: 5000,
      }
    );
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const forceRejectedResidentSignOut = useCallback(async (reason: string | null | undefined) => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(RESIDENT_REJECTED_KEY, "1");

      const trimmedReason = typeof reason === "string" ? reason.trim() : "";
      if (trimmedReason) {
        window.sessionStorage.setItem(RESIDENT_REJECTION_REASON_KEY, trimmedReason);
      } else {
        window.sessionStorage.removeItem(RESIDENT_REJECTION_REASON_KEY);
      }
    }

    await signOut(auth).catch(() => undefined);
    setUser(null);
    writeCachedAuthUser(null);

    if (typeof window !== "undefined" && !window.location.pathname.includes("/signup-resident")) {
      window.location.replace("/signup-resident?reapply=1");
    }
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | null = null;

    const initializeAuthListener = async () => {
      await ensureAuthPersistence();
      if (!active) return;

      unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
        if (!active) return;

        if (!firebaseUser) {
          setUser(null);
          writeCachedAuthUser(null);
          setLoading(false);
          return;
        }

        try {
          const responderProfile = await getResponderProfile(firebaseUser.uid);
          if (!active) return;

          if (responderProfile?.role === "responder") {
            setUser(toResponderUser(firebaseUser.uid, responderProfile, firebaseUser.email));
            return;
          }

          const residentProfile = await getResidentProfile(firebaseUser.uid);
          if (!active) return;

          if (!residentProfile) {
            setUser(null);
            return;
          }

          if (isRejectedResident(residentProfile)) {
            await forceRejectedResidentSignOut(residentProfile.rejectionReason);
            return;
          }

          setUser(toResidentUser(firebaseUser.uid, residentProfile, firebaseUser.email));
        } catch {
          if (!active) return;
          const cached = readCachedAuthUser(firebaseUser.uid);
          setUser(cached);
        } finally {
          if (!active) return;
          setLoading(false);
        }
      });
    };

    void initializeAuthListener();

    return () => {
      active = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [forceRejectedResidentSignOut]);

  useEffect(() => {
    writeCachedAuthUser(user);
  }, [user]);

  useEffect(() => {
    const isResident = user?.role === "resident";
    const residentUid = isResident ? user.id : null;
    if (!isResident || !residentUid || !auth.currentUser || auth.currentUser.uid !== residentUid) {
      return;
    }

    const currentFirebaseUser = auth.currentUser;
    const residentRef = doc(db, "residents", residentUid);
    const unsubscribe = onSnapshot(residentRef, async (snapshot) => {
      if (!snapshot.exists()) {
        return;
      }

      const residentProfile = snapshot.data() as ResidentProfileDoc;

      if (isRejectedResident(residentProfile)) {
        await forceRejectedResidentSignOut(residentProfile.rejectionReason);
        return;
      }

      setUser((current) => {
        if (!current || current.role !== "resident") {
          return current;
        }

        return toResidentUser(
          residentUid,
          residentProfile,
          currentFirebaseUser.email
        );
      });
    });

    return () => {
      try {
        unsubscribe();
      } catch {
        // Guard against Firestore SDK assertion during rapid teardown.
      }
    };
  }, [forceRejectedResidentSignOut, user?.id, user?.role]);

  useEffect(() => {
    const isResponder = user?.role === "responder";
    const responderUid = isResponder ? user.id : null;
    if (!isResponder || !responderUid || !auth.currentUser || auth.currentUser.uid !== responderUid) {
      return;
    }

    const currentFirebaseUser = auth.currentUser;
    const responderRef = doc(db, "responders", responderUid);
    const unsubscribe = onSnapshot(responderRef, (snapshot) => {
      if (!snapshot.exists()) {
        void signOut(auth).catch(() => undefined);
        setUser(null);
        return;
      }

      const responderProfile = snapshot.data() as ResponderProfileDoc;
      if (responderProfile.role !== "responder") {
        void signOut(auth).catch(() => undefined);
        setUser(null);
        return;
      }

      setUser((current) => {
        if (!current || current.role !== "responder") {
          return current;
        }

        return toResponderUser(
          responderUid,
          responderProfile,
          currentFirebaseUser.email
        );
      });
    });

    return () => {
      try {
        unsubscribe();
      } catch {
        // Guard against Firestore SDK assertion during rapid teardown.
      }
    };
  }, [user?.id, user?.role]);

  useEffect(() => {
    const isResident = user?.role === "resident";
    const residentUid = isResident ? user.id : null;
    if (!isResident || !residentUid) {
      return;
    }

    if (typeof window === "undefined" || !navigator.geolocation || !auth.currentUser) {
      return;
    }

    const currentUid = residentUid;
    let cancelled = false;
    let lastAcceptedLocation: { lat: number; lng: number; accuracy: number | null } | null = null;
    let lastUploadAt = 0;

    const maybeUploadLocation = async (position: GeolocationPosition) => {
      if (cancelled || !auth.currentUser || auth.currentUser.uid !== currentUid) {
        return;
      }

      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null;
      const now = Date.now();

      const previous = lastAcceptedLocation;
      if (previous) {
        const distance = getDistanceMeters(previous.lat, previous.lng, latitude, longitude);
        const previousAccuracy = previous.accuracy ?? Number.POSITIVE_INFINITY;
        const currentAccuracy = accuracy ?? Number.POSITIVE_INFINITY;

        const likelyDrift =
          distance > 120 &&
          currentAccuracy > 120 &&
          currentAccuracy > previousAccuracy * 1.35;

        if (likelyDrift) {
          return;
        }

        const minUploadIntervalMs = 3000;
        const minDistanceMeters = 6;
        const isSmallMove = distance < minDistanceMeters;
        const tooSoon = now - lastUploadAt < minUploadIntervalMs;

        if (isSmallMove && tooSoon) {
          return;
        }
      }

      try {
        await updateResidentLiveLocation(currentUid, latitude, longitude, accuracy);
        lastAcceptedLocation = { lat: latitude, lng: longitude, accuracy };
        lastUploadAt = now;
      } catch {
        // Ignore transient location sync failures.
      }
    };

    const geoOptions: PositionOptions = {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 2000,
    };

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        void maybeUploadLocation(position);
      },
      () => {
        // Ignore geolocation watch failures and rely on interval fallback.
      },
      geoOptions
    );

    const pollId = window.setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          void maybeUploadLocation(position);
        },
        () => {
          // Ignore transient geolocation read failures.
        },
        geoOptions
      );
    }, 10000);

    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(pollId);
    };
  }, [user?.id, user?.role]);

  useEffect(() => {
    const isResponder = user?.role === "responder";
    const responderUid = isResponder ? user.id : null;
    if (!isResponder || !responderUid || typeof window === "undefined" || !auth.currentUser) {
      return;
    }

    const currentUid = responderUid;
    let cancelled = false;

    const heartbeat = async () => {
      if (cancelled || !auth.currentUser || auth.currentUser.uid !== currentUid) {
        return;
      }

      try {
        await touchResponderSession(currentUid);
      } catch {
        // Ignore transient session heartbeat failures.
      }
    };

    void heartbeat();
    const intervalId = window.setInterval(() => {
      void heartbeat();
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [user?.id, user?.role]);

  useEffect(() => {
    const isResponder = user?.role === "responder";
    const responderUid = isResponder ? user.id : null;
    if (!isResponder || !responderUid) {
      return;
    }

    if (typeof window === "undefined" || !navigator.geolocation || !auth.currentUser) {
      return;
    }

    const currentUid = responderUid;
    let cancelled = false;
    let lastAcceptedLocation: { lat: number; lng: number; accuracy: number | null } | null = null;
    let lastUploadAt = 0;

    const maybeUploadLocation = async (position: GeolocationPosition) => {
      if (cancelled || !auth.currentUser || auth.currentUser.uid !== currentUid) {
        return;
      }

      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null;
      const now = Date.now();

      const previous = lastAcceptedLocation;
      if (previous) {
        const distance = getDistanceMeters(previous.lat, previous.lng, latitude, longitude);
        const previousAccuracy = previous.accuracy ?? Number.POSITIVE_INFINITY;
        const currentAccuracy = accuracy ?? Number.POSITIVE_INFINITY;

        const likelyDrift =
          distance > 120 &&
          currentAccuracy > 120 &&
          currentAccuracy > previousAccuracy * 1.35;

        if (likelyDrift) {
          return;
        }

        const minUploadIntervalMs = 3000;
        const minDistanceMeters = 6;
        const isSmallMove = distance < minDistanceMeters;
        const tooSoon = now - lastUploadAt < minUploadIntervalMs;

        if (isSmallMove && tooSoon) {
          return;
        }
      }

      try {
        await updateResponderLiveLocation(currentUid, latitude, longitude, accuracy);
        lastAcceptedLocation = { lat: latitude, lng: longitude, accuracy };
        lastUploadAt = now;
      } catch {
        // Ignore transient location sync failures.
      }
    };

    const geoOptions: PositionOptions = {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 2000,
    };

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        void maybeUploadLocation(position);
      },
      () => {
        // Ignore geolocation watch failures and rely on interval fallback.
      },
      geoOptions
    );

    const pollId = window.setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          void maybeUploadLocation(position);
        },
        () => {
          // Ignore transient geolocation read failures.
        },
        geoOptions
      );
    }, 10000);

    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(pollId);
    };
  }, [user?.id, user?.role]);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);

    try {
      await ensureAuthPersistence();
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail || !password) {
        throw new Error("Email and password are required.");
      }

      const candidatePasswords = [password];
      const trimmedPassword = password.trim();
      if (trimmedPassword && trimmedPassword !== password) {
        candidatePasswords.push(trimmedPassword);
      }

      let credential: Awaited<ReturnType<typeof signInWithEmailAndPassword>> | null = null;
      let lastSignInError: unknown = null;

      for (const candidatePassword of candidatePasswords) {
        try {
          credential = await signInWithEmailAndPassword(auth, normalizedEmail, candidatePassword);
          break;
        } catch (signInError) {
          lastSignInError = signInError;
        }
      }

      if (!credential) {
        throw lastSignInError || new Error("Unable to sign in.");
      }

      const responderProfile = await getResponderProfile(credential.user.uid);
      if (responderProfile?.role === "responder") {
        await startResponderSession(credential.user.uid);
        const responderUser = toResponderUser(
          credential.user.uid,
          responderProfile,
          credential.user.email
        );
        setUser(responderUser);
        return responderUser;
      }

      const residentProfile = await getResidentProfile(credential.user.uid);

      if (!residentProfile) {
        await signOut(auth);
        throw new Error("Account profile not found. Please contact support.");
      }

      if (isRejectedResident(residentProfile)) {
        await forceRejectedResidentSignOut(residentProfile.rejectionReason);
        throw new Error("Registration rejected. Please sign up again.");
      }

      const residentUser = toResidentUser(credential.user.uid, residentProfile, credential.user.email);
      setUser(residentUser);
      return residentUser;
    } catch (error) {
      throw new Error(mapAuthError(error));
    } finally {
      setLoading(false);
    }
  }, [forceRejectedResidentSignOut]);

  const registerResident = useCallback(async (data: ResidentRegistrationInput) => {
    setLoading(true);

    try {
      await ensureAuthPersistence();
      const municipality = "Banisilan";
      const normalizedEmail = data.email.trim().toLowerCase();
      const fullName = data.fullName.trim();

      if (!normalizedEmail || !data.password) {
        throw new Error("Email and password are required.");
      }

      const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, data.password);
      await updateProfile(credential.user, { displayName: fullName });

      const residentRef = doc(db, "residents", credential.user.uid);
      await setDoc(residentRef, {
        uid: credential.user.uid,
        role: "resident",
        fullName,
        email: normalizedEmail,
        phone: data.phone.trim(),
        address: data.address.trim(),
        barangay: data.barangay.trim(),
        city: municipality,
        validIdUrl: typeof data.validIdUrl === "string" ? data.validIdUrl.trim() : "",
        residencyProofUrl: typeof data.residencyProofUrl === "string" ? data.residencyProofUrl.trim() : "",
        verified: false,
        verificationStatus: "pending",
        rejectionReason: null,
        verifiedAt: null,
        idType: data.idType.trim(),
        idNumber: data.idNumber.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setUser({
        id: credential.user.uid,
        name: fullName,
        email: normalizedEmail,
        role: "resident",
      });
    } catch (error) {
      throw new Error(mapAuthError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      const currentUid = auth.currentUser?.uid;
      if (user?.role === "responder" && currentUid) {
        // Best-effort final location sync before ending session/sign-out.
        try {
          const finalLocation = await captureCurrentPosition();
          if (finalLocation) {
            await updateResponderLiveLocation(
              currentUid,
              finalLocation.lat,
              finalLocation.lng,
              finalLocation.accuracy
            );
          }
        } catch {
          // Ignore best-effort final location sync failures.
        }

        // Best-effort session end write: never block sign-out on network/rules issues.
        await endResponderSession(currentUid).catch(() => undefined);
      }

      await signOut(auth).catch(() => undefined);
    } catch {
      // If there is no active Firebase session, continue clearing local auth state.
    } finally {
      setUser(null);
      writeCachedAuthUser(null);
      setLoading(false);
    }
  }, [user]);

  return (
    <AuthContext.Provider
      value={{ user, loading, login, registerResident, logout, isAuthenticated: !!user }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}

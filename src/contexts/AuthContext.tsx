import { createContext, useContext, useState, useCallback, ReactNode, useEffect } from "react";
import { FirebaseError } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export type UserRole = "resident" | "responder";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
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
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string, role: UserRole) => Promise<void>;
  registerResident: (data: ResidentRegistrationInput) => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);
export const RESIDENT_REJECTED_KEY = "mdrrmo_resident_rejected";
export const RESIDENT_REJECTION_REASON_KEY = "mdrrmo_resident_rejection_reason";

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
  const responderLocationRef = doc(db, "responderLiveLocations", uid);
  await setDoc(responderLocationRef, {
    uid,
    liveLocation: {
      latitude,
      longitude,
      lat: latitude,
      lng: longitude,
      accuracy,
    },
    liveLocationUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });
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

    if (typeof window !== "undefined" && !window.location.pathname.includes("/signup-resident")) {
      window.location.replace("/signup-resident?reapply=1");
    }
  }, []);

  useEffect(() => {
    let active = true;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!active) return;

      if (!firebaseUser) {
        setUser(null);
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
        setUser(null);
      } finally {
        if (!active) return;
        setLoading(false);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [forceRejectedResidentSignOut]);

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

    const pushLiveLocation = () => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          if (cancelled || !auth.currentUser || auth.currentUser.uid !== currentUid) {
            return;
          }

          try {
            const residentRef = doc(db, "residents", currentUid);
            await updateDoc(residentRef, {
              liveLocation: {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy ?? null,
              },
              liveLocationUpdatedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch {
            // Ignore transient location sync failures.
          }
        },
        () => {
          // Ignore geolocation read failures to avoid blocking auth.
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      );
    };

    pushLiveLocation();
    const intervalId = window.setInterval(pushLiveLocation, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
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

    const pushLiveLocation = () => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          if (cancelled || !auth.currentUser || auth.currentUser.uid !== currentUid) {
            return;
          }

          try {
            await updateResponderLiveLocation(
              currentUid,
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy ?? null
            );
          } catch {
            // Ignore transient location sync failures.
          }
        },
        () => {
          // Ignore geolocation read failures to avoid blocking auth.
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      );
    };

    pushLiveLocation();
    const intervalId = window.setInterval(pushLiveLocation, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [user?.id, user?.role]);

  const login = useCallback(async (email: string, password: string, role: UserRole) => {
    setLoading(true);

    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail || !password) {
        throw new Error("Email and password are required.");
      }

      const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);

      if (role === "resident") {
        const residentProfile = await getResidentProfile(credential.user.uid);

        if (!residentProfile) {
          await signOut(auth);
          throw new Error("Resident profile not found. Please contact support.");
        }

        if (isRejectedResident(residentProfile)) {
          await forceRejectedResidentSignOut(residentProfile.rejectionReason);
          throw new Error("Registration rejected. Please sign up again.");
        }

        setUser(toResidentUser(credential.user.uid, residentProfile, credential.user.email));
        return;
      }

      const responderProfile = await getResponderProfile(credential.user.uid);
      if (!responderProfile || responderProfile.role !== "responder") {
        await signOut(auth);
        throw new Error("Responder profile not found. Please contact admin.");
      }

      await startResponderSession(credential.user.uid);
      setUser(toResponderUser(credential.user.uid, responderProfile, credential.user.email));
    } catch (error) {
      throw new Error(mapAuthError(error));
    } finally {
      setLoading(false);
    }
  }, [forceRejectedResidentSignOut]);

  const registerResident = useCallback(async (data: ResidentRegistrationInput) => {
    setLoading(true);

    try {
      const municipality = "Banisilan";
      const normalizedEmail = data.email.trim().toLowerCase();
      const fullName = data.fullName.trim();

      if (!normalizedEmail || !data.password) {
        throw new Error("Email and password are required.");
      }

      if (!data.validIdUrl || !data.residencyProofUrl) {
        throw new Error("Verification document uploads are required.");
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
        validIdUrl: data.validIdUrl.trim(),
        residencyProofUrl: data.residencyProofUrl.trim(),
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
        // Best-effort session end write: never block sign-out on network/rules issues.
        void endResponderSession(currentUid).catch(() => undefined);
      }

      await signOut(auth).catch(() => undefined);
    } catch {
      // If there is no active Firebase session, continue clearing local auth state.
    } finally {
      setUser(null);
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

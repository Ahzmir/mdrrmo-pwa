import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, LogOut, Save, Settings as SettingsIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { auth, db } from "@/lib/firebase";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { updateProfile } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { toast } from "sonner";

interface ResidentProfile {
  fullName: string;
  phone: string;
  address: string;
  barangay: string;
  city: string;
  idType: string;
  idNumber: string;
  role: string;
  uid: string;
  verified: boolean;
  verificationStatus: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string;
  liveLocation: string;
  validIdUrl: string;
  residencyProofUrl: string;
}

function sanitizeString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sanitizeBoolean(value: unknown) {
  return value === true;
}

function formatTimestamp(value: unknown) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if ("toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    try {
      return (value as { toDate: () => Date }).toDate().toLocaleString();
    } catch {
      return "";
    }
  }

  return "";
}

function formatLiveLocation(value: unknown) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const lat = (value as { latitude?: unknown }).latitude;
  const lng = (value as { longitude?: unknown }).longitude;
  const accuracy = (value as { accuracy?: unknown }).accuracy;

  const latitude = typeof lat === "number" ? lat.toFixed(6) : null;
  const longitude = typeof lng === "number" ? lng.toFixed(6) : null;
  const accuracyText = typeof accuracy === "number" ? `${Math.round(accuracy)}m` : null;

  if (!latitude || !longitude) {
    return "";
  }

  return accuracyText ? `${latitude}, ${longitude} (${accuracyText})` : `${latitude}, ${longitude}`;
}

async function resolveResidentDocId(residentUid: string) {
  const directRef = doc(db, "residents", residentUid);
  const directSnap = await getDoc(directRef);
  if (directSnap.exists()) {
    return residentUid;
  }

  const residentsRef = collection(db, "residents");
  const byUidQuery = query(residentsRef, where("uid", "==", residentUid), limit(1));
  const querySnap = await getDocs(byUidQuery);
  if (!querySnap.empty) {
    return querySnap.docs[0].id;
  }

  throw new Error("Resident profile not found.");
}

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [profile, setProfile] = useState<ResidentProfile>({
    fullName: "",
    phone: "",
    address: "",
    barangay: "",
    city: "",
    idType: "",
    idNumber: "",
    role: "",
    uid: "",
    verified: false,
    verificationStatus: "",
    createdAt: "",
    updatedAt: "",
    verifiedAt: "",
    liveLocation: "",
    validIdUrl: "",
    residencyProofUrl: "",
  });
  const [baselineProfile, setBaselineProfile] = useState<ResidentProfile>({
    fullName: "",
    phone: "",
    address: "",
    barangay: "",
    city: "",
    idType: "",
    idNumber: "",
    role: "",
    uid: "",
    verified: false,
    verificationStatus: "",
    createdAt: "",
    updatedAt: "",
    verifiedAt: "",
    liveLocation: "",
    validIdUrl: "",
    residencyProofUrl: "",
  });
  const [savingProfile, setSavingProfile] = useState(false);
  const infoInputClass =
    "w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm text-foreground outline-none backdrop-blur-md";
  const infoLabelClass = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  useEffect(() => {
    const nextProfile: ResidentProfile = {
      fullName: user?.name || "",
      phone: "",
      address: "",
      barangay: "",
      city: "Banisilan",
      idType: "",
      idNumber: "",
      role: "resident",
      uid: user?.id || "",
      verified: false,
      verificationStatus: "",
      createdAt: "",
      updatedAt: "",
      verifiedAt: "",
      liveLocation: "",
      validIdUrl: "",
      residencyProofUrl: "",
    };

    if (!user?.id) {
      setProfile(nextProfile);
      setBaselineProfile(nextProfile);
      return;
    }

    const residentRef = doc(db, "residents", user.id);
    const byUidQuery = query(collection(db, "residents"), where("uid", "==", user.id), limit(1));
    let cancelled = false;

    const load = async () => {
      try {
        const [directSnap, byUidSnap] = await Promise.all([getDoc(residentRef), getDocs(byUidQuery)]);
        const source = directSnap.exists()
          ? directSnap.data()
          : !byUidSnap.empty
            ? byUidSnap.docs[0].data()
            : null;

        if (!source || cancelled) return;

        const loaded: ResidentProfile = {
          fullName: sanitizeString(source.fullName) || sanitizeString(source.name) || user.name,
          phone: sanitizeString(source.phone),
          address: sanitizeString(source.address),
          barangay: sanitizeString(source.barangay),
          city: sanitizeString(source.city) || "Banisilan",
          idType: sanitizeString(source.idType),
          idNumber: sanitizeString(source.idNumber),
          role: sanitizeString(source.role) || "resident",
          uid: sanitizeString(source.uid) || user.id,
          verified: sanitizeBoolean(source.verified),
          verificationStatus: sanitizeString(source.verificationStatus) || "pending",
          createdAt: formatTimestamp(source.createdAt),
          updatedAt: formatTimestamp(source.updatedAt),
          verifiedAt: formatTimestamp(source.verifiedAt),
          liveLocation: formatLiveLocation(source.liveLocation),
          validIdUrl: sanitizeString(source.validIdUrl),
          residencyProofUrl: sanitizeString(source.residencyProofUrl),
        };

        setProfile(loaded);
        setBaselineProfile(loaded);
      } catch {
        if (!cancelled) {
          setProfile((current) => ({ ...current, fullName: user.name || current.fullName }));
          setBaselineProfile((current) => ({ ...current, fullName: user.name || current.fullName }));
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.name]);

  const hasProfileChanges = useMemo(() => {
    return (
      profile.fullName.trim() !== baselineProfile.fullName.trim() ||
      profile.phone.trim() !== baselineProfile.phone.trim() ||
      profile.address.trim() !== baselineProfile.address.trim() ||
      profile.barangay.trim() !== baselineProfile.barangay.trim() ||
      profile.city.trim() !== baselineProfile.city.trim()
    );
  }, [
    baselineProfile.address,
    baselineProfile.barangay,
    baselineProfile.city,
    baselineProfile.fullName,
    baselineProfile.phone,
    profile.address,
    profile.barangay,
    profile.city,
    profile.fullName,
    profile.phone,
  ]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setLoggingOut(false);
    }
  }

  async function handleSaveProfile() {
    if (!user?.id) {
      toast.error("You must be logged in to update profile.");
      return;
    }

    const trimmedName = profile.fullName.trim();
    if (!trimmedName) {
      toast.error("Full name is required.");
      return;
    }

    setSavingProfile(true);
    try {
      const residentDocId = await resolveResidentDocId(user.id);
      const residentRef = doc(db, "residents", residentDocId);

      await updateDoc(residentRef, {
        fullName: trimmedName,
        name: trimmedName,
        phone: profile.phone.trim(),
        address: profile.address.trim(),
        barangay: profile.barangay.trim(),
        city: profile.city.trim() || "Banisilan",
        updatedAt: serverTimestamp(),
      });

      if (auth.currentUser && auth.currentUser.displayName !== trimmedName) {
        await updateProfile(auth.currentUser, { displayName: trimmedName });
      }

      const next = {
        ...profile,
        fullName: trimmedName,
        phone: profile.phone.trim(),
        address: profile.address.trim(),
        barangay: profile.barangay.trim(),
        city: profile.city.trim() || "Banisilan",
      };

      setProfile(next);
      setBaselineProfile(next);
      toast.success("Resident profile updated.");
    } catch {
      toast.error("Unable to save profile right now. Please try again.");
    } finally {
      setSavingProfile(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-4 pb-24">
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/45 bg-white/45 p-4 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <button onClick={() => navigate(-1)} className="p-1 text-muted-foreground">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-orange-600">Settings</h1>
      </div>

      <div className="space-y-4 rounded-2xl border border-white/45 bg-white/45 p-4 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <div className="rounded-xl border border-white/55 bg-white/60 p-4 backdrop-blur-md">
          <div className="flex items-center gap-2 text-foreground">
            <SettingsIcon size={16} className="text-orange-600" />
            <p className="text-sm font-semibold">Profile</p>
          </div>

          <div className="mt-3 space-y-2">
            <input
              type="text"
              value={profile.fullName}
              onChange={(event) => setProfile((current) => ({ ...current, fullName: event.target.value }))}
              placeholder="Full name"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <input
              type="tel"
              value={profile.phone}
              onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))}
              placeholder="Phone number"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <input
              type="text"
              value={profile.address}
              onChange={(event) => setProfile((current) => ({ ...current, address: event.target.value }))}
              placeholder="Address"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={profile.barangay}
                onChange={(event) => setProfile((current) => ({ ...current, barangay: event.target.value }))}
                placeholder="Barangay"
                className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
              />
              <input
                type="text"
                value={profile.city}
                onChange={(event) => setProfile((current) => ({ ...current, city: event.target.value }))}
                placeholder="City"
                className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleSaveProfile()}
            disabled={savingProfile || !hasProfileChanges}
            className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white transition-transform active:scale-[0.98] disabled:opacity-70"
          >
            {savingProfile ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {savingProfile ? "Saving..." : "Save Profile"}
          </button>
        </div>

        <div className="rounded-xl border border-white/55 bg-white/60 p-4 backdrop-blur-md">
          <div className="flex items-center gap-2 text-foreground">
            <SettingsIcon size={16} className="text-orange-600" />
            <p className="text-sm font-semibold">Information</p>
          </div>

          <div className="mt-3 space-y-2">
            <div className="space-y-1">
              <p className={infoLabelClass}>Email</p>
              <input readOnly value={user?.email || "Resident"} placeholder="Email" className={infoInputClass} />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <p className={infoLabelClass}>Role</p>
                <input readOnly value={profile.role || "resident"} placeholder="Role" className={infoInputClass} />
              </div>
              <div className="space-y-1">
                <p className={infoLabelClass}>Verified</p>
                <input readOnly value={profile.verified ? "Yes" : "No"} placeholder="Verified" className={infoInputClass} />
              </div>
            </div>
            <div className="space-y-1">
              <p className={infoLabelClass}>UID</p>
              <input readOnly value={profile.uid || user?.id || "N/A"} placeholder="UID" className={infoInputClass} />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <p className={infoLabelClass}>Phone</p>
                <input readOnly value={profile.phone || "Not set"} placeholder="Phone" className={infoInputClass} />
              </div>
              <div className="space-y-1">
                <p className={infoLabelClass}>Barangay</p>
                <input readOnly value={profile.barangay || "Not set"} placeholder="Barangay" className={infoInputClass} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <p className={infoLabelClass}>City</p>
                <input readOnly value={profile.city || "Banisilan"} placeholder="City" className={infoInputClass} />
              </div>
              <div className="space-y-1">
                <p className={infoLabelClass}>Verification Status</p>
                <input
                  readOnly
                  value={profile.verificationStatus || "pending"}
                  placeholder="Verification Status"
                  className={infoInputClass}
                />
              </div>
            </div>
            <div className="space-y-1">
              <p className={infoLabelClass}>Address</p>
              <input readOnly value={profile.address || "Not set"} placeholder="Address" className={infoInputClass} />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <p className={infoLabelClass}>ID Type</p>
                <input readOnly value={profile.idType || "Not set"} placeholder="ID Type" className={infoInputClass} />
              </div>
              <div className="space-y-1">
                <p className={infoLabelClass}>ID Number</p>
                <input readOnly value={profile.idNumber || "Not set"} placeholder="ID Number" className={infoInputClass} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <p className={infoLabelClass}>Created At</p>
                <input readOnly value={profile.createdAt || "N/A"} placeholder="Created At" className={infoInputClass} />
              </div>
              <div className="space-y-1">
                <p className={infoLabelClass}>Updated At</p>
                <input readOnly value={profile.updatedAt || "N/A"} placeholder="Updated At" className={infoInputClass} />
              </div>
            </div>
            <div className="space-y-1">
              <p className={infoLabelClass}>Verified At</p>
              <input readOnly value={profile.verifiedAt || "N/A"} placeholder="Verified At" className={infoInputClass} />
            </div>
            <div className="space-y-1">
              <p className={infoLabelClass}>Live Location</p>
              <input readOnly value={profile.liveLocation || "N/A"} placeholder="Live Location" className={infoInputClass} />
            </div>
            <div className="space-y-1">
              <p className={infoLabelClass}>Valid ID URL</p>
              <textarea
                readOnly
                value={profile.validIdUrl || "N/A"}
                placeholder="Valid ID URL"
                rows={2}
                className={infoInputClass}
              />
            </div>
            <div className="space-y-1">
              <p className={infoLabelClass}>Residency Proof URL</p>
              <textarea
                readOnly
                value={profile.residencyProofUrl || "N/A"}
                placeholder="Residency Proof URL"
                rows={2}
                className={infoInputClass}
              />
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setLogoutConfirmOpen(true)}
          disabled={loggingOut}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-3 text-sm font-semibold text-white transition-transform active:scale-[0.98] disabled:opacity-70"
        >
          <LogOut size={16} />
          {loggingOut ? "Signing out..." : "Sign Out"}
        </button>

        <AlertDialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out now?</AlertDialogTitle>
              <AlertDialogDescription>
                You will need to sign in again to access resident reporting and account settings.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={loggingOut}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={loggingOut}
                onClick={() => {
                  void handleLogout();
                }}
              >
                Sign Out
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

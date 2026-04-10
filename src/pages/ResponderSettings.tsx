import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, LogOut, Save, Settings as SettingsIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { auth, db } from "@/lib/firebase";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  updateProfile,
} from "firebase/auth";
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

interface ResponderProfile {
  name: string;
  phone: string;
  station: string;
  unit: string;
  status: string;
}

function sanitizeString(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function resolveResponderDocId(responderUid: string) {
  const directRef = doc(db, "responders", responderUid);
  const directSnap = await getDoc(directRef);
  if (directSnap.exists()) {
    return responderUid;
  }

  const respondersRef = collection(db, "responders");
  const byUidQuery = query(respondersRef, where("uid", "==", responderUid), limit(1));
  const querySnap = await getDocs(byUidQuery);
  if (!querySnap.empty) {
    return querySnap.docs[0].id;
  }

  throw new Error("Responder profile not found.");
}

export default function ResponderSettings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [profile, setProfile] = useState<ResponderProfile>({
    name: "",
    phone: "",
    station: "",
    unit: "",
    status: "",
  });
  const [baselineProfile, setBaselineProfile] = useState<ResponderProfile>({
    name: "",
    phone: "",
    station: "",
    unit: "",
    status: "",
  });
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  useEffect(() => {
    const nextProfile: ResponderProfile = {
      name: user?.name || "",
      phone: "",
      station: "",
      unit: "",
      status: "",
    };

    if (user?.id) {
      const responderRef = doc(db, "responders", user.id);
      const byUidQuery = query(collection(db, "responders"), where("uid", "==", user.id), limit(1));

      let cancelled = false;

      const load = async () => {
        try {
          const [directSnap, byUidSnap] = await Promise.all([getDoc(responderRef), getDocs(byUidQuery)]);

          const source = directSnap.exists()
            ? directSnap.data()
            : !byUidSnap.empty
              ? byUidSnap.docs[0].data()
              : null;

          if (!source || cancelled) return;

          const loaded: ResponderProfile = {
            name: sanitizeString(source.name) || user.name,
            phone: sanitizeString(source.phone),
            station: sanitizeString(source.station),
            unit: sanitizeString(source.unit),
            status: sanitizeString(source.status),
          };

          setProfile(loaded);
          setBaselineProfile(loaded);
        } catch {
          if (!cancelled) {
            setProfile((current) => ({ ...current, name: user.name || current.name }));
            setBaselineProfile((current) => ({ ...current, name: user.name || current.name }));
          }
        }
      };

      void load();

      return () => {
        cancelled = true;
      };
    }

    setProfile(nextProfile);
    setBaselineProfile(nextProfile);
  }, [user?.id, user?.name]);

  const hasProfileChanges = useMemo(() => {
    return (
      profile.name.trim() !== baselineProfile.name.trim() ||
      profile.phone.trim() !== baselineProfile.phone.trim() ||
      profile.station.trim() !== baselineProfile.station.trim() ||
      profile.unit.trim() !== baselineProfile.unit.trim()
    );
  }, [baselineProfile.name, baselineProfile.phone, baselineProfile.station, baselineProfile.unit, profile.name, profile.phone, profile.station, profile.unit]);

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

    const trimmedName = profile.name.trim();
    if (!trimmedName) {
      toast.error("Name is required.");
      return;
    }

    setSavingProfile(true);
    try {
      const responderDocId = await resolveResponderDocId(user.id);
      const responderRef = doc(db, "responders", responderDocId);

      await updateDoc(responderRef, {
        name: trimmedName,
        phone: profile.phone.trim(),
        station: profile.station.trim(),
        unit: profile.unit.trim(),
        updatedAt: serverTimestamp(),
      });

      if (auth.currentUser && auth.currentUser.displayName !== trimmedName) {
        await updateProfile(auth.currentUser, { displayName: trimmedName });
      }

      const next = {
        ...profile,
        name: trimmedName,
        phone: profile.phone.trim(),
        station: profile.station.trim(),
        unit: profile.unit.trim(),
      };

      setProfile(next);
      setBaselineProfile(next);
      toast.success("Responder profile updated.");
    } catch {
      toast.error("Unable to save profile right now. Please try again.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleChangePassword() {
    const currentUser = auth.currentUser;
    if (!currentUser || !currentUser.email) {
      toast.error("You must be logged in to change password.");
      return;
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error("Please complete all password fields.");
      return;
    }

    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation do not match.");
      return;
    }

    if (newPassword === currentPassword) {
      toast.error("New password must be different from current password.");
      return;
    }

    setChangingPassword(true);
    try {
      const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated successfully.");
      setPasswordModalOpen(false);
    } catch {
      toast.error("Unable to change password. Check your current password and try again.");
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-4 pb-24">
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/45 bg-white/45 p-4 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <button onClick={() => navigate(-1)} className="p-1 text-muted-foreground">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-orange-600">Responder Settings</h1>
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
              value={profile.name}
              onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))}
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

          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <p>Email: <span className="font-medium text-foreground">{user?.email || "Responder"}</span></p>
            <p>Station: <span className="font-medium text-foreground">{profile.station || "Not set"}</span></p>
            <p>Unit: <span className="font-medium text-foreground">{profile.unit || "Not set"}</span></p>
            <p>Status: <span className="font-medium text-foreground">{profile.status || "Unknown"}</span></p>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={profile.station}
              onChange={(event) => setProfile((current) => ({ ...current, station: event.target.value }))}
              placeholder="Station"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <input
              type="text"
              value={profile.unit}
              onChange={(event) => setProfile((current) => ({ ...current, unit: event.target.value }))}
              placeholder="Unit"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
          </div>

          <button
            type="button"
            onClick={() => void handleSaveProfile()}
            disabled={savingProfile || !hasProfileChanges}
            className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white transition-transform active:scale-[0.98] disabled:opacity-70"
          >
            {savingProfile ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {savingProfile ? "Saving..." : "Save Information"}
          </button>
        </div>

        <div className="rounded-xl border border-white/55 bg-white/60 p-4 backdrop-blur-md">
          <div className="flex items-center gap-2 text-foreground">
            <SettingsIcon size={16} className="text-orange-600" />
            <p className="text-sm font-semibold">Change Password</p>
          </div>

          <button
            type="button"
            onClick={() => setPasswordModalOpen(true)}
            className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white transition-transform active:scale-[0.98]"
          >
            Change Password
          </button>
        </div>

        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-3 text-sm font-semibold text-white transition-transform active:scale-[0.98] disabled:opacity-70"
        >
          <LogOut size={16} />
          {loggingOut ? "Signing out..." : "Sign Out"}
        </button>
      </div>

      <Dialog
        open={passwordModalOpen}
        onOpenChange={(open) => {
          setPasswordModalOpen(open);
          if (!open && !changingPassword) {
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
          }
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-md rounded-2xl border border-white/55 bg-white/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
            <DialogDescription>Enter your current password, then set a new one.</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder="Current password"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="New password"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Confirm new password"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
          </div>

          <button
            type="button"
            onClick={() => void handleChangePassword()}
            disabled={changingPassword}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white transition-transform active:scale-[0.98] disabled:opacity-70"
          >
            {changingPassword ? <Loader2 size={14} className="animate-spin" /> : null}
            {changingPassword ? "Updating..." : "Update Password"}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

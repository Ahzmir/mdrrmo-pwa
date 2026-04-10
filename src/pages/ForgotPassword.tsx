import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sendPasswordResetEmail } from "firebase/auth";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { ArrowLeft, Loader2 } from "lucide-react";
import { auth, db } from "@/lib/firebase";
import { toast } from "sonner";

type ResetTab = "email" | "phone";

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function phoneCandidates(value: string) {
  const digits = normalizePhone(value);
  if (!digits) return [];

  const variants = new Set<string>([digits]);

  if (digits.startsWith("0") && digits.length >= 11) {
    variants.add(`63${digits.slice(1)}`);
    variants.add(`+63${digits.slice(1)}`);
  }

  if (digits.startsWith("63") && digits.length >= 12) {
    variants.add(`0${digits.slice(2)}`);
    variants.add(`+${digits}`);
  }

  if (value.trim().startsWith("+")) {
    variants.add(value.trim());
  }

  return Array.from(variants).slice(0, 10);
}

async function findEmailByPhone(phoneNumber: string) {
  const candidates = phoneCandidates(phoneNumber);
  if (!candidates.length) return null;

  const residentQuery = query(
    collection(db, "residents"),
    where("phone", "in", candidates),
    limit(1)
  );
  const residentSnap = await getDocs(residentQuery);
  const residentEmail = residentSnap.docs[0]?.data()?.email;
  if (typeof residentEmail === "string" && residentEmail.trim()) {
    return residentEmail.trim().toLowerCase();
  }

  const responderQuery = query(
    collection(db, "responders"),
    where("phone", "in", candidates),
    limit(1)
  );
  const responderSnap = await getDocs(responderQuery);
  const responderEmail = responderSnap.docs[0]?.data()?.email;
  if (typeof responderEmail === "string" && responderEmail.trim()) {
    return responderEmail.trim().toLowerCase();
  }

  return null;
}

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<ResetTab>("email");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSendReset() {
    let targetEmail = email.trim().toLowerCase();

    if (activeTab === "phone") {
      const matchedEmail = await findEmailByPhone(phoneNumber);
      if (!matchedEmail) {
        toast.error("No account found for that phone number.");
        return;
      }
      targetEmail = matchedEmail;
    }

    if (!targetEmail) {
      toast.error(
        activeTab === "email"
          ? "Please enter your email to receive a reset link."
          : "Please enter your phone number to continue."
      );
      return;
    }

    setSubmitting(true);
    try {
      await sendPasswordResetEmail(auth, targetEmail);
      toast.success("Password reset email sent. Check your inbox.");
      navigate("/login", { replace: true });
    } catch {
      toast.error("Unable to send reset email right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 animate-fade-in bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)]">
      <div className="w-full max-w-sm space-y-5">
        <div className="rounded-2xl border border-white/45 bg-white/45 p-5 text-center space-y-2 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
          <h1 className="text-3xl font-black leading-tight text-orange-600">Forgot Password</h1>
          <p className="text-sm text-muted-foreground">Choose email or phone number to recover your account.</p>
        </div>

        <div className="rounded-2xl border border-white/45 bg-white/45 p-5 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/55 bg-white/50 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("email")}
              className={`rounded-lg py-2 text-sm font-semibold transition-colors ${
                activeTab === "email"
                  ? "bg-orange-600 text-white"
                  : "text-muted-foreground hover:bg-white/70"
              }`}
            >
              Email
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("phone")}
              className={`rounded-lg py-2 text-sm font-semibold transition-colors ${
                activeTab === "phone"
                  ? "bg-orange-600 text-white"
                  : "text-muted-foreground hover:bg-white/70"
              }`}
            >
              Phone Number
            </button>
          </div>

          {activeTab === "email" ? (
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email address"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3.5 text-sm placeholder:text-muted-foreground outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
          ) : (
            <input
              type="tel"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              placeholder="Phone number"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3.5 text-sm placeholder:text-muted-foreground outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
          )}

          <button
            type="button"
            onClick={() => void handleSendReset()}
            disabled={submitting}
            className="w-full rounded-2xl bg-orange-600 py-4 text-base font-bold text-white flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70"
          >
            {submitting ? <Loader2 size={20} className="animate-spin" /> : "Send Reset Link"}
          </button>

          <p className="text-xs text-center text-muted-foreground">
            For phone recovery, we send reset instructions to the email linked to that number.
          </p>

          <Link
            to="/login"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/55 bg-white/55 px-4 py-2 text-sm font-semibold text-foreground"
          >
            <ArrowLeft size={16} />
            Back to Login
          </Link>
        </div>
      </div>
    </div>
  );
}

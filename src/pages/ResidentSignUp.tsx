import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  RESIDENT_REJECTED_KEY,
  RESIDENT_REJECTION_REASON_KEY,
  useAuth,
} from "@/contexts/AuthContext";
import { ArrowLeft, BadgeCheck, Loader2, ShieldCheck, Upload } from "lucide-react";
import { uploadFileToCloudinary } from "@/lib/cloudinary";

type RegistrationForm = {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  phone: string;
  address: string;
  barangay: string;
  city: string;
  idType: string;
  idNumber: string;
};

const idTypes = ["National ID", "Driver's License", "Passport", "Voter's ID", "Barangay ID"];
const MUNICIPALITY = "Banisilan";

function isStrongPassword(password: string) {
  return /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}

export default function ResidentSignUp() {
  const { registerResident, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isReapply = searchParams.get("reapply") === "1";

  const [form, setForm] = useState<RegistrationForm>({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
    address: "",
    barangay: "",
    city: MUNICIPALITY,
    idType: idTypes[0],
    idNumber: "",
  });
  const [residencyProof, setResidencyProof] = useState<File | null>(null);
  const [validIdPhoto, setValidIdPhoto] = useState<File | null>(null);
  const [uploadingVerification, setUploadingVerification] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!isReapply) {
      setRejectionReason(null);
      return;
    }

    const storedReason = window.sessionStorage.getItem(RESIDENT_REJECTION_REASON_KEY);
    const trimmedReason = storedReason?.trim();
    setRejectionReason(trimmedReason ? trimmedReason : null);
  }, [isReapply]);

  function updateField<K extends keyof RegistrationForm>(key: K, value: RegistrationForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.fullName || !form.email || !form.password || !form.phone || !form.address || !form.barangay || !form.idNumber) {
      setError("Please complete all required resident identity fields.");
      return;
    }

    if (form.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (!isStrongPassword(form.password)) {
      setError("Password must include at least one uppercase letter, one number, and one symbol.");
      return;
    }

    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (!validIdPhoto || !residencyProof) {
      setError("Upload your valid ID and proof of residency.");
      return;
    }

    if (!agreed) {
      setError("You must confirm the information is true and verifiable.");
      return;
    }

    try {
      setUploadingVerification(true);
      const [validIdUrl, residencyProofUrl] = await Promise.all([
        uploadFileToCloudinary(validIdPhoto),
        uploadFileToCloudinary(residencyProof),
      ]);

      await registerResident({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        phone: form.phone.trim(),
        address: form.address.trim(),
        barangay: form.barangay.trim(),
        city: MUNICIPALITY,
        idType: form.idType,
        idNumber: form.idNumber.trim(),
        validIdUrl,
        residencyProofUrl,
      });

      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(RESIDENT_REJECTED_KEY);
        window.sessionStorage.removeItem(RESIDENT_REJECTION_REASON_KEY);
      }

      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message || "Unable to create resident account.");
    } finally {
      setUploadingVerification(false);
    }
  }

  return (
    <div className="min-h-screen px-4 py-6 max-w-xl mx-auto animate-fade-in">
        <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => navigate("/login")}
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Resident Access</p>
          <h1 className="text-xl font-black text-foreground">Resident Sign Up</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {isReapply && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-warning-foreground">
            <p>Your previous registration was rejected. Submit a new sign-up for review.</p>
            {rejectionReason ? (
              <p className="mt-2 text-warning">
                Rejection reason: {rejectionReason}
              </p>
            ) : null}
          </div>
        )}
        <section className="bg-card rounded-xl border p-4 space-y-3 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BadgeCheck size={16} className="text-info" />
            Identity Information
          </div>
          <input
            value={form.fullName}
            onChange={(e) => updateField("fullName", e.target.value)}
            placeholder="Full legal name"
            className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
          />
          <input
            type="email"
            value={form.email}
            onChange={(e) => updateField("email", e.target.value)}
            placeholder="Email address"
            className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="password"
              value={form.password}
              onChange={(e) => updateField("password", e.target.value)}
              placeholder="Password (min 8 chars)"
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
            />
            <input
              type="password"
              value={form.confirmPassword}
              onChange={(e) => updateField("confirmPassword", e.target.value)}
              placeholder="Confirm password"
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Password must be at least 8 characters and include an uppercase letter, a number, and a symbol.
          </p>
        </section>

        <section className="bg-card rounded-xl border p-4 space-y-3 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck size={16} className="text-success" />
            Residency Details
          </div>
          <input
            value={form.phone}
            onChange={(e) => updateField("phone", e.target.value)}
            placeholder="Mobile number (e.g. 09171234567)"
            className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
          />
          <input
            value={form.address}
            onChange={(e) => updateField("address", e.target.value)}
            placeholder="House no. / street / subdivision"
            className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              value={form.barangay}
              onChange={(e) => updateField("barangay", e.target.value)}
              placeholder="Barangay"
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
            />
            <input
              value={MUNICIPALITY}
              readOnly
              aria-label="Municipality"
              className="w-full bg-muted rounded-xl px-4 py-3 text-sm text-muted-foreground"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Municipality is fixed to Banisilan.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={form.idType}
              onChange={(e) => updateField("idType", e.target.value)}
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
            >
              {idTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
            <input
              value={form.idNumber}
              onChange={(e) => updateField("idNumber", e.target.value)}
              placeholder="ID number"
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emergency/30"
            />
          </div>
        </section>

        <section className="bg-card rounded-xl border p-4 space-y-3 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Upload size={16} className="text-warning" />
            Document Verification
          </div>
          <label className="block text-xs font-semibold text-muted-foreground">Upload valid government ID</label>
          <input
            type="file"
            accept="image/*,.pdf"
            onChange={(e) => setValidIdPhoto(e.target.files?.[0] ?? null)}
            className="w-full text-xs text-muted-foreground"
          />
          <label className="block text-xs font-semibold text-muted-foreground">Upload proof of residency (utility bill/barangay certificate)</label>
          <input
            type="file"
            accept="image/*,.pdf"
            onChange={(e) => setResidencyProof(e.target.files?.[0] ?? null)}
            className="w-full text-xs text-muted-foreground"
          />
        </section>

        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5"
          />
          I confirm that all details are real and I agree that false information may result in account suspension.
        </label>

        {error && <p className="text-sm text-destructive animate-slide-up">{error}</p>}

        <button
          type="submit"
          disabled={loading || uploadingVerification}
          className="w-full bg-emergency text-emergency-foreground rounded-2xl py-4 font-bold text-base flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70"
        >
          {loading || uploadingVerification ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              {uploadingVerification ? "Uploading verification files..." : "Creating account..."}
            </>
          ) : (
            "Create Verified Resident Account"
          )}
        </button>
      </form>

      <p className="text-xs text-center text-muted-foreground mt-5">
        Already verified? <Link to="/login" className="text-emergency font-semibold">Sign in here</Link>
      </p>
    </div>
  );
}

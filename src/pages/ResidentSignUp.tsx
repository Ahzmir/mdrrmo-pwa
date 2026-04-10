import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  RESIDENT_REJECTED_KEY,
  RESIDENT_REJECTION_REASON_KEY,
  useAuth,
} from "@/contexts/AuthContext";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, BadgeCheck, Check, ChevronDown, Loader2, ShieldCheck, Upload } from "lucide-react";
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
const BARANGAYS_BANISILAN = [
  "Banisilan (Pob.)",
  "Busaon",
  "Camalig",
  "Gastao",
  "Kalawaeg",
  "Malinao",
  "Nalagap",
  "Paradise",
  "Pantar",
  "Pinamulaan",
  "Salama",
  "Tinimbacan",
  "Thailand",
  "Alimudan",
  "Badiangon",
  "Capayangan",
  "Datu Inda",
  "Datu Mantil",
  "Pantuca-B",
  "Soliman",
];

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
  const [barangayPickerOpen, setBarangayPickerOpen] = useState(false);

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
    <div className="min-h-screen max-w-xl mx-auto animate-fade-in bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.18),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.14),transparent_42%)] px-4 py-6">
        <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => navigate("/login")}
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Resident Access</p>
          <h1 className="text-4xl font-black text-slate-950 leading-tight">Resident Sign Up</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {isReapply && (
          <div className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-warning-foreground backdrop-blur-md shadow-[0_14px_35px_-26px_rgba(245,158,11,0.6)]">
            <p>Your previous registration was rejected. Submit a new sign-up for review.</p>
            {rejectionReason ? (
              <p className="mt-2 text-warning">
                Rejection reason: {rejectionReason}
              </p>
            ) : null}
          </div>
        )}
        <section className="rounded-2xl border border-white/45 bg-white/45 p-4 space-y-3 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BadgeCheck size={16} className="text-warning" />
            Identity Information
          </div>
          <input
            value={form.fullName}
            onChange={(e) => updateField("fullName", e.target.value)}
            placeholder="Full legal name"
            className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
          />
          <input
            type="email"
            value={form.email}
            onChange={(e) => updateField("email", e.target.value)}
            placeholder="Email address"
            className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="password"
              value={form.password}
              onChange={(e) => updateField("password", e.target.value)}
              placeholder="Password (min 8 chars)"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <input
              type="password"
              value={form.confirmPassword}
              onChange={(e) => updateField("confirmPassword", e.target.value)}
              placeholder="Confirm password"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Password must be at least 8 characters and include an uppercase letter, a number, and a symbol.
          </p>
        </section>

        <section className="rounded-2xl border border-white/45 bg-white/45 p-4 space-y-3 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck size={16} className="text-success" />
            Residency Details
          </div>
          <input
            value={form.phone}
            onChange={(e) => updateField("phone", e.target.value)}
            placeholder="Mobile number (e.g. 09171234567)"
            className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
          />
          <input
            value={form.address}
            onChange={(e) => updateField("address", e.target.value)}
            placeholder="House no. / street / subdivision"
            className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setBarangayPickerOpen(true)}
              className="h-[50px] w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            >
              <span className="flex items-center justify-between gap-2">
                <span className={form.barangay ? "text-foreground" : "text-muted-foreground"}>
                  {form.barangay || "Select barangay"}
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </span>
            </button>
            <input
              value={MUNICIPALITY}
              readOnly
              aria-label="Municipality"
              className="w-full rounded-xl border border-white/55 bg-white/35 px-4 py-3 text-sm text-muted-foreground backdrop-blur-md"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Municipality is fixed to Banisilan.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={form.idType}
              onChange={(e) => updateField("idType", e.target.value)}
              className="h-[50px] w-full appearance-none rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            >
              {idTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <input
              value={form.idNumber}
              onChange={(e) => updateField("idNumber", e.target.value)}
              placeholder="ID number"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3 text-sm outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
          </div>
        </section>

        <section className="rounded-2xl border border-white/45 bg-white/45 p-4 space-y-3 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl animate-slide-up">
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
          className="w-full rounded-2xl py-4 font-bold text-base flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70 bg-slate-950 text-white shadow-[0_16px_35px_-20px_rgba(15,23,42,0.8)]"
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

      <Dialog open={barangayPickerOpen} onOpenChange={setBarangayPickerOpen}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-md rounded-2xl border border-white/45 bg-white/85 p-0 backdrop-blur-xl">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle>Select barangay</DialogTitle>
            <DialogDescription>Choose your barangay in Banisilan.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto px-3 pt-2 pb-3">
            {BARANGAYS_BANISILAN.map((barangay) => {
              const isSelected = form.barangay === barangay;
              return (
                <button
                  key={barangay}
                  type="button"
                  onClick={() => {
                    updateField("barangay", barangay);
                    setBarangayPickerOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm ${
                    isSelected ? "bg-warning/15 text-foreground" : "hover:bg-muted/60"
                  }`}
                >
                  <span>{barangay}</span>
                  {isSelected ? <Check className="h-4 w-4 text-warning" /> : null}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Flame,
  HeartPulse,
  ShieldAlert,
  CloudLightning,
  MapPin,
  Camera,
  Loader2,
  CheckCircle2,
  ArrowLeft,
} from "lucide-react";
import { IncidentCategory } from "@/types/incident";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { db } from "@/lib/firebase";
import { loadGoogleMapsApi } from "@/lib/googleMaps";
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
import { addDoc, collection, doc, getDoc, getDocFromServer, serverTimestamp } from "firebase/firestore";
import { uploadImageToFirebaseStorage } from "@/lib/storageUpload";
import {
  addOfflineSmsReport,
  markOfflineSmsReportAttempted,
  type OfflineSmsReportEntry,
} from "@/lib/offlineSmsReports";
import { toast } from "sonner";

const categories: { id: IncidentCategory; icon: typeof Flame; label: string; color: string }[] = [
  { id: "fire", icon: Flame, label: "Fire", color: "border-fire text-fire bg-fire/10" },
  { id: "medical", icon: HeartPulse, label: "Medical", color: "border-medical text-medical bg-medical/10" },
  { id: "crime", icon: ShieldAlert, label: "Crime", color: "border-crime text-crime bg-crime/10" },
  { id: "disaster", icon: CloudLightning, label: "Disaster", color: "border-disaster text-disaster bg-disaster/10" },
];

function getVerifiedCacheKey(uid: string) {
  return `mdrrmo_resident_verified_${uid}`;
}

function mapGeolocationError(error: GeolocationPositionError | { message?: string; code?: number }) {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Location requires HTTPS on Safari. Open the app using an https:// URL (not IP/localhost).";
  }

  const message = (error.message || "").toLowerCase();
  if (message.includes("origin does not have permission") || message.includes("secure")) {
    return "Safari blocked location for this origin. Use HTTPS and enable Settings > Privacy & Security > Location Services > Safari Websites > While Using the App, then reload.";
  }

  if (error.code === 1) {
    return "Location permission denied. In iPhone Settings, allow Safari location access and reload the app.";
  }

  if (error.code === 2) {
    return "Unable to determine your location. Check signal/GPS and try again.";
  }

  if (error.code === 3) {
    return "Location request timed out. Move to an open area and try again.";
  }

  return error.message || "Unable to access your current location.";
}

export default function ReportForm() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const watchIdRef = useRef<number | null>(null);
  const manualMapContainerRef = useRef<HTMLDivElement | null>(null);
  const manualMapRef = useRef<google.maps.Map | null>(null);
  const manualMarkerRef = useRef<google.maps.Marker | null>(null);
  const manualMapClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const manualMarkerDragListenerRef = useRef<google.maps.MapsEventListener | null>(null);

  const [category, setCategory] = useState<IncidentCategory | null>(null);
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [locationMode, setLocationMode] = useState<"gps" | "manual">("gps");
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");
  const [manualMapReady, setManualMapReady] = useState(false);
  const [manualMapError, setManualMapError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [verificationChecked, setVerificationChecked] = useState(false);
  const [isResidentVerified, setIsResidentVerified] = useState(false);
  const [residentBarangay, setResidentBarangay] = useState<string | null>(null);
  const [residentPhone, setResidentPhone] = useState<string | null>(null);
  const [verificationMessage, setVerificationMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [forceOfflineMode, setForceOfflineMode] = useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const firebaseProjectId = (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined) || "(missing-project-id)";

  const effectiveOffline = offline || forceOfflineMode;

  const smsFallbackNumber = (import.meta.env.VITE_SMS_FALLBACK_NUMBER as string | undefined)?.trim() || "+639177044103";

  function categoryToSmsLabel(value: IncidentCategory) {
    if (value === "fire") return "FIRE";
    if (value === "medical") return "MEDICAL";
    if (value === "crime") return "CRIME";
    return "DISASTER";
  }

  function normalizeOneLine(value: string) {
    return value
      .replace(/[;|]+/g, " ")
      .replace(/\r\n|\n|\r/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildSmsFallbackMessage() {
    if (!category || !location || !coordinates) {
      const missing: string[] = [];
      if (!category) missing.push("category");
      if (!location || !coordinates) missing.push("location");
      setSubmitError(`Please complete required fields: ${missing.join(" and ")}.`);
      return null;
    }

    const oneLineLocation = normalizeOneLine(location);
    const oneLineDescription = normalizeOneLine(description) || "N/A";
    const oneLineReporter = normalizeOneLine(user?.name || "Resident");

    const messageLines = [
      "MDRRMO INCIDENT REPORT",
      `CATEGORY: ${categoryToSmsLabel(category)}`,
      `LOCATION: ${oneLineLocation}`,
      `COORDS: ${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}`,
      `DESCRIPTION: ${oneLineDescription}`,
      `REPORTER: ${oneLineReporter}`,
      `TIME: ${new Date().toLocaleString()}`,
    ];

    return messageLines.join("; ");
  }

  function launchSmsFallback(message: string) {
    const encodedBody = encodeURIComponent(normalizeOneLine(message));
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const smsUri = isIos
      ? `sms:${smsFallbackNumber}&body=${encodedBody}`
      : `sms:${smsFallbackNumber}?body=${encodedBody}`;

    window.location.href = smsUri;
  }

  function queueOfflineSmsHistory(message: string) {
    if (!user || user.role !== "resident" || !category || !coordinates) {
      return null;
    }

    const entry: OfflineSmsReportEntry = {
      id: `offline-sms-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      residentId: user.id,
      category,
      description: description.trim(),
      location,
      coordinates,
      createdAtIso: new Date().toISOString(),
      smsNumber: smsFallbackNumber,
      smsBody: message,
      deliveryStatus: "queued",
      lastAttemptAtIso: null,
      sentAtIso: null,
      failureReason: null,
      semaphoreMessageId: null,
    };

    addOfflineSmsReport(entry);
    return entry;
  }

  useEffect(() => {
    const handleOnline = () => {
      setOffline(false);
    };
    const handleOffline = () => setOffline(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    async function checkVerification() {
      if (!user || user.role !== "resident") {
        if (!mounted) return;
        setIsResidentVerified(true);
        setVerificationChecked(true);
        setVerificationMessage(null);
        return;
      }

      const verifiedCacheKey = getVerifiedCacheKey(user.id);
      const cachedApproved =
        typeof window !== "undefined" && window.localStorage.getItem(verifiedCacheKey) === "1";

      // Keep UI responsive if we already verified before, but still fetch profile
      // so report metadata (e.g., phone/barangay) is always populated.
      if (cachedApproved) {
        if (!mounted) return;
        setIsResidentVerified(true);
        setVerificationMessage(null);
      }

      try {
        const residentRef = doc(db, "residents", user.id);
        const residentSnap = await getDoc(residentRef);

        if (!mounted) return;

        if (!residentSnap.exists()) {
          setIsResidentVerified(false);
          setVerificationMessage("Your resident profile is missing. Please contact admin.");
          return;
        }

        const residentData = residentSnap.data();
        setResidentBarangay(typeof residentData.barangay === "string" ? residentData.barangay : null);
        setResidentPhone(typeof residentData.phone === "string" ? residentData.phone : null);
        const approved =
          residentData.verified === true || residentData.verificationStatus === "approved";

        setIsResidentVerified(approved);
        if (approved && typeof window !== "undefined") {
          window.localStorage.setItem(verifiedCacheKey, "1");
        }
        setVerificationMessage(
          approved
            ? null
            : "Your account is pending admin verification. You can log in, but reporting is disabled until approval."
        );
      } catch {
        if (!mounted) return;
        if (!cachedApproved) {
          setIsResidentVerified(false);
          setVerificationMessage(
            "Unable to verify your registration status right now. Please try again in a moment."
          );
        }
      } finally {
        if (mounted) {
          setVerificationChecked(true);
        }
      }
    }

    void checkVerification();

    return () => {
      mounted = false;
    };
  }, [user]);

  function detectLocation() {
    if (!isResidentVerified) {
      setSubmitError("Reporting is disabled until your registration is approved by admin.");
      return;
    }

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setLocationError("Location requires HTTPS on Safari. Open the app using an https:// URL.");
      return;
    }

    if (!navigator.geolocation) {
      setLocationError("Geolocation is not supported on this device.");
      return;
    }

    setLocationMode("gps");
    setLocating(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoordinates({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        setManualLat("");
        setManualLng("");
        setLocation(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
        setLocating(false);
      },
      (error) => {
        setLocationError(mapGeolocationError(error));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function setManualPin(lat: number, lng: number) {
    setLocationMode("manual");
    setCoordinates({ lat, lng });
    setManualLat(lat.toFixed(6));
    setManualLng(lng.toFixed(6));
    setLocation(`${lat.toFixed(5)}, ${lng.toFixed(5)} (manual pin)`);
    setLocationError(null);
    setSubmitError(null);
  }

  useEffect(() => {
    if (!verificationChecked || !isResidentVerified) {
      return;
    }

    if (locationMode === "manual") {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setLocating(false);
      return;
    }

    if (!navigator.geolocation) {
      setLocationError("Geolocation is not supported on this device.");
      return;
    }

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setLocationError("Location requires HTTPS on Safari. Open the app using an https:// URL.");
      return;
    }

    setLocating(true);
    setLocationError(null);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setCoordinates({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        setManualLat("");
        setManualLng("");
        setLocation(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
        setLocating(false);
        setLocationError(null);
      },
      (error) => {
        setLocationError(mapGeolocationError(error));
        setLocating(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000,
      }
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [verificationChecked, isResidentVerified, locationMode]);

  useEffect(() => {
    if (locationMode !== "manual") {
      return;
    }

    let cancelled = false;

    void loadGoogleMapsApi()
      .then(() => {
        if (cancelled || !manualMapContainerRef.current) {
          return;
        }

        const initialCenter = coordinates ?? { lat: 7.5, lng: 124.8 };

        if (!manualMapRef.current) {
          const map = new google.maps.Map(manualMapContainerRef.current, {
            center: initialCenter,
            zoom: coordinates ? 16 : 12,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
            clickableIcons: false,
            gestureHandling: "greedy",
            mapId: import.meta.env.VITE_GOOGLE_MAP_ID || "DEMO_MAP_ID",
          });

          manualMapRef.current = map;

          manualMarkerRef.current = new google.maps.Marker({
            map,
            position: initialCenter,
            draggable: true,
            title: "Manual incident pin",
          });

          manualMapClickListenerRef.current = map.addListener("click", (event: google.maps.MapMouseEvent) => {
            if (!event.latLng || !manualMarkerRef.current) {
              return;
            }

            const lat = event.latLng.lat();
            const lng = event.latLng.lng();
            manualMarkerRef.current.setPosition({ lat, lng });
            setManualPin(lat, lng);
          });

          manualMarkerDragListenerRef.current = manualMarkerRef.current.addListener("dragend", (event: google.maps.MapMouseEvent) => {
            if (!event.latLng) {
              return;
            }

            const lat = event.latLng.lat();
            const lng = event.latLng.lng();
            setManualPin(lat, lng);
          });
        }

        if (manualMapRef.current) {
          const target = coordinates ?? initialCenter;
          manualMapRef.current.setCenter(target);
          if (!coordinates) {
            manualMapRef.current.setZoom(12);
          }
        }

        if (manualMarkerRef.current && coordinates) {
          manualMarkerRef.current.setPosition(coordinates);
        }

        setManualMapReady(true);
        setManualMapError(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setManualMapReady(false);
        const reason = (error as { message?: string }).message || "Unable to load Google Maps.";
        setManualMapError(reason);
      });

    return () => {
      cancelled = true;
    };
  }, [locationMode, coordinates]);

  useEffect(() => {
    return () => {
      manualMapClickListenerRef.current?.remove();
      manualMapClickListenerRef.current = null;
      manualMarkerDragListenerRef.current?.remove();
      manualMarkerDragListenerRef.current = null;
      if (manualMarkerRef.current) {
        manualMarkerRef.current.setMap(null);
      }
      manualMarkerRef.current = null;
      manualMapRef.current = null;
      setManualMapReady(false);
    };
  }, []);

  function applyManualPin() {
    const lat = Number.parseFloat(manualLat.trim());
    const lng = Number.parseFloat(manualLng.trim());

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setLocationError("Enter valid latitude and longitude values.");
      return;
    }

    if (lat < -90 || lat > 90) {
      setLocationError("Latitude must be between -90 and 90.");
      return;
    }

    if (lng < -180 || lng > 180) {
      setLocationError("Longitude must be between -180 and 180.");
      return;
    }

    setManualPin(lat, lng);
    if (manualMapRef.current) {
      manualMapRef.current.setCenter({ lat, lng });
      manualMapRef.current.setZoom(16);
    }
    if (manualMarkerRef.current) {
      manualMarkerRef.current.setPosition({ lat, lng });
    }
  }

  function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    const reader = new FileReader();
    reader.onload = () => setPhotoPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleSubmit() {
    if (isSubmitting) {
      return;
    }

    if (!category || !location || !coordinates) {
      const missing: string[] = [];
      if (!category) missing.push("category");
      if (!location || !coordinates) missing.push("location");
      setSubmitError(`Please complete required fields: ${missing.join(" and ")}.`);
      return;
    }

    if (effectiveOffline) {
      setSubmitError(null);
      const smsMessage = buildSmsFallbackMessage();
      if (!smsMessage) {
        return;
      }

      const queuedEntry = queueOfflineSmsHistory(smsMessage);
      if (!queuedEntry) {
        setSubmitError("Unable to queue SMS fallback report right now.");
        return;
      }

      if (!navigator.onLine) {
        toast.info("No internet connection. Opening SMS app now. Send the report SMS to continue.");
      } else {
        toast.info("SMS fallback mode is active. Opening SMS app now. Send the report SMS to continue.");
      }

      launchSmsFallback(smsMessage);
      markOfflineSmsReportAttempted(queuedEntry.id);

      setSubmitted(true);
      return;
    }

    setSubmitError(null);

    if (!user || user.role !== "resident") {
      setSubmitError("Only signed-in resident accounts can submit reports.");
      return;
    }

    if (!isResidentVerified) {
      setVerificationMessage(
        "Your account is pending admin verification. Please wait for approval to submit incident reports."
      );
      setSubmitError("Reporting is currently locked for unverified residents.");
      return;
    }

    setIsSubmitting(true);

    const priorityByCategory: Record<IncidentCategory, "Critical" | "High"> = {
      fire: "Critical",
      medical: "Critical",
      disaster: "High",
      crime: "High",
    };

    const titleByCategory: Record<IncidentCategory, string> = {
      fire: "Fire Incident",
      medical: "Medical Emergency",
      disaster: "Disaster Incident",
      crime: "Crime Incident",
    };

    let uploadedPhotoUrl: string | null = null;
    if (photoFile) {
      setUploadingPhoto(true);
      try {
        uploadedPhotoUrl = await uploadImageToFirebaseStorage(photoFile);
      } catch (error) {
        const message = (error as Error).message || "Unable to upload photo right now. Please try again.";
        setSubmitError(message);
        setUploadingPhoto(false);
        setIsSubmitting(false);
        return;
      } finally {
        setUploadingPhoto(false);
      }
    }

    try {
      const incidentRef = await addDoc(collection(db, "incidents"), {
        title: titleByCategory[category],
        category,
        description: description.trim(),
        priority: priorityByCategory[category],
        status: "Pending",
        source: "Web",
        location,
        barangay: residentBarangay || "Banisilan",
        lat: coordinates.lat,
        lng: coordinates.lng,
        photoUrl: uploadedPhotoUrl,
        residentId: user.id,
        residentName: user.name,
        residentEmail: user.email,
        residentPhone: residentPhone || "",
        assignedResponders: [],
        reportedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const createdDoc = await getDocFromServer(incidentRef);
      if (!createdDoc.exists()) {
        throw new Error(`Incident write was not visible on server yet. Doc ID: ${incidentRef.id}`);
      }

      toast.success(`Report saved: ${incidentRef.id}`);
      console.info("[report-submit] incident-created", {
        projectId: firebaseProjectId,
        incidentId: incidentRef.id,
        residentId: user.id,
      });
    } catch (error) {
      const code = (error as { code?: string }).code || "unknown";
      const message = (error as { message?: string }).message || "unknown error";

      if ((error as { code?: string }).code === "permission-denied") {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(getVerifiedCacheKey(user.id));
        }
        setIsResidentVerified(false);
        setVerificationMessage(
          "Your account is not currently approved for incident reporting."
        );
        setSubmitError(`Reporting is currently locked for your account. [${firebaseProjectId}] (${code})`);
        setIsSubmitting(false);
        return;
      }

      setSubmitError(
        `Unable to submit incident report right now. [${firebaseProjectId}] (${code}) ${message}`
      );
      setIsSubmitting(false);
      return;
    }

    setSubmitted(true);
    setIsSubmitting(false);
  }

  function openSubmitConfirmation() {
    if (
      !verificationChecked ||
      !isResidentVerified ||
      uploadingPhoto ||
      isSubmitting
    ) {
      return;
    }

    setSubmitConfirmOpen(true);
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center gap-4 animate-fade-in">
        <div className="w-20 h-20 rounded-full bg-success-light flex items-center justify-center transition-all duration-500">
          <CheckCircle2 size={40} className="text-success" />
        </div>
        <h2 className="text-xl font-bold text-foreground">Report Submitted</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          Your emergency report has been received. Help is being coordinated.
          You can track your report status.
        </p>
        <div className="flex gap-3 mt-4 w-full max-w-xs">
          <button
            onClick={() => navigate("/my-reports")}
            className="flex-1 bg-foreground text-background rounded-xl py-3 font-semibold text-sm"
          >
            View Reports
          </button>
          <button
            onClick={() => navigate("/")}
            className="flex-1 border border-border rounded-xl py-3 font-semibold text-sm text-foreground"
          >
            Home
          </button>
        </div>
      </div>
    );
  }

  if (!verificationChecked) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center gap-4 animate-fade-in">
        <Loader2 size={30} className="animate-spin text-emergency" />
        <p className="text-sm text-muted-foreground">Checking account verification status...</p>
      </div>
    );
  }

  if (!isResidentVerified) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center gap-4 animate-fade-in">
        <div className="w-16 h-16 rounded-full bg-warning/15 flex items-center justify-center">
          <ShieldAlert size={30} className="text-warning" />
        </div>
        <h2 className="text-xl font-bold text-foreground">Verification Pending</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          {verificationMessage || "Your registration is still pending admin approval."}
        </p>
        <button
          onClick={() => navigate("/")}
          className="rounded-xl border border-border px-4 py-2 text-sm font-semibold text-foreground"
        >
          Back to Home
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg animate-fade-in bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)] px-4 pt-4 pb-24">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/45 bg-white/45 px-3 py-3 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
        <button onClick={() => navigate(-1)} className="p-1 text-muted-foreground">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold text-orange-600">Report Incident</h1>
      </div>

      {/* Category Selection */}
      <div className="mb-5">
        <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">
          Category
        </label>
        <div className="grid grid-cols-2 gap-2">
          {categories.map((cat) => {
            const Icon = cat.icon;
            const selected = category === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setCategory(cat.id)}
                className={cn(
                  "flex items-center gap-2 rounded-xl border-2 bg-white/60 p-3 text-sm font-semibold backdrop-blur-md transition-all",
                  selected
                    ? cat.color + " border-current"
                    : "border-border text-muted-foreground hover:border-foreground/20"
                )}
              >
                <Icon size={20} />
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Location */}
      <div className="mb-5">
        <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">
          Location
        </label>
        <div className="mb-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => {
              setLocationMode("gps");
              setSubmitError(null);
            }}
            className={cn(
              "rounded-lg border px-3 py-2 text-xs font-semibold transition-colors",
              locationMode === "gps"
                ? "border-orange-500 bg-orange-50 text-orange-700"
                : "border-white/55 bg-white/60 text-foreground"
            )}
          >
            GPS Pin
          </button>
          <button
            onClick={() => {
              setLocationMode("manual");
              setLocating(false);
              setLocationError(null);
              setSubmitError(null);
            }}
            className={cn(
              "rounded-lg border px-3 py-2 text-xs font-semibold transition-colors",
              locationMode === "manual"
                ? "border-orange-500 bg-orange-50 text-orange-700"
                : "border-white/55 bg-white/60 text-foreground"
            )}
          >
            Manual Pin
          </button>
        </div>

        {locationMode === "manual" && (
          <div className="mb-2 rounded-xl border border-white/55 bg-white/60 p-3 backdrop-blur-md">
            <div className="mb-2">
              <div ref={manualMapContainerRef} className="h-52 w-full rounded-lg border border-white/60 bg-muted/40" />
              {!manualMapReady && !manualMapError ? (
                <p className="mt-1 text-[11px] text-muted-foreground">Loading Google Maps...</p>
              ) : null}
              {manualMapError ? (
                <p className="mt-1 text-[11px] text-destructive">
                  {manualMapError} You can still pin manually using coordinates.
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Tap the map to drop a pin, then drag marker to fine-tune location.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={manualLat}
                onChange={(event) => setManualLat(event.target.value)}
                inputMode="decimal"
                placeholder="Latitude"
                className="rounded-lg border border-white/60 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-warning/35"
              />
              <input
                value={manualLng}
                onChange={(event) => setManualLng(event.target.value)}
                inputMode="decimal"
                placeholder="Longitude"
                className="rounded-lg border border-white/60 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-warning/35"
              />
            </div>
            <button
              onClick={applyManualPin}
              className="mt-2 rounded-lg border border-white/55 bg-white/70 px-3 py-2 text-xs font-semibold text-foreground"
            >
              Pin Coordinates
            </button>
          </div>
        )}
        <div
          className={cn(
            "rounded-xl border bg-white/60 px-4 py-3 text-sm backdrop-blur-md transition-all duration-300",
            location
              ? "border-success/30 shadow-[0_0_0_1px_hsl(var(--success)/0.15)]"
              : "border-transparent",
            locating ? "animate-pulse" : ""
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <MapPin size={16} className={cn("shrink-0", location ? "text-success" : "text-muted-foreground")} />
              <p className={cn("truncate", location ? "text-foreground" : "text-muted-foreground")}>
                {location || (locationMode === "manual" ? "Enter coordinates and pin manually." : "Detecting your current location...")}
              </p>
            </div>
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full shrink-0 transition-all duration-300",
                location
                  ? "bg-success shadow-[0_0_0_6px_hsl(var(--success)/0.18)]"
                  : locating
                    ? "bg-warning animate-pulse"
                    : "bg-muted-foreground/40"
              )}
            />
          </div>
        </div>
        <div className="flex gap-2 mt-2">
          <button
            onClick={detectLocation}
            disabled={locating || locationMode === "manual"}
            className="flex items-center gap-2 rounded-xl border border-white/55 bg-white/60 px-4 py-2 text-sm font-medium text-foreground backdrop-blur-md transition-all duration-200 disabled:opacity-60"
          >
            {locating ? <Loader2 size={18} className="animate-spin" /> : <MapPin size={18} />}
            {locating ? "Updating..." : "Refresh GPS"}
          </button>
          {locationError ? (
            <p className="text-[11px] text-destructive animate-slide-up">{locationError}</p>
          ) : null}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1 ml-1 animate-slide-up">
          Use GPS Pin for automatic live location, or Manual Pin with Google Maps and coordinate fallback.
        </p>
      </div>

      {/* Description */}
      <div className="mb-5">
        <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">
          Description <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Briefly describe the emergency..."
          className="w-full resize-none rounded-xl border border-white/55 bg-white/60 px-4 py-3 text-sm placeholder:text-muted-foreground outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
        />
      </div>

      {/* Photo Upload */}
      <div className="mb-6">
        <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">
          Photo <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhoto} />
        {photoPreview ? (
          <div className="relative overflow-hidden rounded-xl border border-white/55 bg-white/60 backdrop-blur-md">
            <img src={photoPreview} alt="Incident" className="w-full h-40 object-cover" />
            <button
              onClick={() => {
                setPhotoPreview(null);
                setPhotoFile(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              className="absolute top-2 right-2 bg-foreground/70 text-background rounded-full px-2 py-0.5 text-xs font-medium"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-white/55 bg-white/50 py-6 text-muted-foreground backdrop-blur-md transition-colors hover:border-orange-300"
          >
            <Camera size={24} />
            <span className="text-xs font-medium">Tap to take or upload photo</span>
          </button>
        )}
      </div>

      {/* Submit */}
      <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-white/55 bg-white/50 px-3 py-2 backdrop-blur-md">
        <p className="text-xs text-muted-foreground">
          Manual test toggle for SMS fallback mode.
        </p>
        <button
          onClick={() => setForceOfflineMode((current) => !current)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
            forceOfflineMode
              ? "bg-warning text-warning-foreground"
              : "bg-muted text-muted-foreground"
          )}
        >
          {forceOfflineMode ? "Disable Offline Mode" : "Enable Offline Mode"}
        </button>
      </div>

      {effectiveOffline && (
        <div className="mb-3 rounded-xl border-2 border-dashed border-warning bg-warning-light px-3 py-2">
          <p className="text-xs font-semibold text-warning-foreground">
            SMS fallback mode is active. The app will open your SMS app to send one incident message to {smsFallbackNumber}. After gateway receive, admin will review and convert it to an incident report.
          </p>
        </div>
      )}
      {(!category || !location || !coordinates) && (
        <p className="mb-2 text-xs text-muted-foreground">
          Required: choose a category and wait for GPS location lock.
        </p>
      )}
      <button
        onClick={openSubmitConfirmation}
        disabled={
          !verificationChecked ||
          !isResidentVerified ||
          uploadingPhoto ||
          isSubmitting
        }
        className={cn(
          "w-full rounded-2xl py-4 text-base font-bold transition-all",
          category &&
            location &&
            coordinates &&
            verificationChecked &&
            isResidentVerified &&
            !uploadingPhoto &&
            !isSubmitting
            ? "bg-orange-600 text-white shadow-lg active:scale-[0.98]"
            : "bg-muted text-muted-foreground cursor-not-allowed"
        )}
      >
        {uploadingPhoto ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 size={18} className="animate-spin" />
            Uploading image...
          </span>
        ) : isSubmitting ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 size={18} className="animate-spin" />
            Submitting report...
          </span>
        ) : (
          effectiveOffline ? "Send via SMS Fallback" : "Submit Report"
        )}
      </button>
      {submitError && <p className="mt-2 text-xs text-destructive">{submitError}</p>}

      <AlertDialog open={submitConfirmOpen} onOpenChange={setSubmitConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {effectiveOffline ? "Send SMS fallback report now?" : "Submit incident report now?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {effectiveOffline
                ? "This uses SMS fallback only: open SMS app, send the formatted one-line report, then gateway/admin intake and conversion follows."
                : "Please confirm the report details are correct before sending to MDRRMO."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting || uploadingPhoto}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSubmitting || uploadingPhoto}
              onClick={() => {
                void handleSubmit();
              }}
            >
              {effectiveOffline ? "Send via SMS Fallback" : "Submit Report"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

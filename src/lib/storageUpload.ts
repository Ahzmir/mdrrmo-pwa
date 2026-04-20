import { getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { storage } from "@/lib/firebase";

const UPLOAD_TIMEOUT_MS = 25000;

function buildUploadPath(folder: string, file: File) {
  const extension = (() => {
    const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "bin";
  })();

  const uniqueId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return `${folder}/${Date.now()}-${uniqueId}.${extension}`;
}

async function uploadToFirebaseStorage(file: File, folder: string) {
  const path = buildUploadPath(folder, file);
  const fileRef = ref(storage, path);

  try {
    await new Promise<void>((resolve, reject) => {
      const uploadTask = uploadBytesResumable(fileRef, file, {
        contentType: file.type || undefined,
        cacheControl: "public,max-age=31536000,immutable",
      });

      const timeoutId = window.setTimeout(() => {
        uploadTask.cancel();
        reject(new Error("Upload timed out while waiting for Firebase Storage."));
      }, UPLOAD_TIMEOUT_MS);

      uploadTask.on(
        "state_changed",
        undefined,
        (error) => {
          window.clearTimeout(timeoutId);
          reject(error);
        },
        () => {
          window.clearTimeout(timeoutId);
          resolve();
        }
      );
    });
  } catch (error) {
    const message = (error as { message?: string }).message || "Unknown upload error.";
    const code = (error as { code?: string }).code || "";
    const normalized = `${code} ${message}`.toLowerCase();

    if (
      normalized.includes("cors") ||
      normalized.includes("preflight") ||
      normalized.includes("xmlhttprequest") ||
      normalized.includes("err_failed")
    ) {
      throw new Error(
        "Photo upload blocked by Firebase Storage CORS. Configure bucket CORS for your dev origin (for example http://localhost:8081), then retry."
      );
    }

    if (code === "storage/canceled") {
      throw new Error("Photo upload timed out. Check internet connection and retry.");
    }

    if (code === "storage/unauthorized") {
      throw new Error("Photo upload not authorized by Firebase Storage rules.");
    }

    throw error;
  }

  return getDownloadURL(fileRef);
}

export async function uploadImageToFirebaseStorage(file: File) {
  return uploadToFirebaseStorage(file, "incident-photos");
}

export async function uploadFileToFirebaseStorage(file: File) {
  return uploadToFirebaseStorage(file, "resident-verification");
}
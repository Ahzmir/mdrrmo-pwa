const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

function validateConfig() {
  if (!cloudName || !uploadPreset) {
    throw new Error(
      "Cloudinary is not configured. Set VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET."
    );
  }

  if (/^\d{8,}$/.test(cloudName)) {
    throw new Error(
      "VITE_CLOUDINARY_CLOUD_NAME looks like an API key. Use your Cloudinary cloud name (not API key/secret)."
    );
  }
}

function mapCloudinaryError(status: number, payload: unknown, fallback: string) {
  const message =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
      ? (payload as { error: { message: string } }).error.message
      : fallback;

  if (status === 401) {
    return (
      `${message} (Cloudinary 401). ` +
      "Check cloud name and make sure the upload preset exists and is set to Unsigned."
    );
  }

  return message;
}

export async function uploadImageToCloudinary(file: File) {
  validateConfig();

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset as string);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: "POST",
      body: formData,
    }
  );

  const payload = await response.json();

  if (!response.ok) {
    const message = mapCloudinaryError(
      response.status,
      payload,
      "Cloudinary upload failed."
    );
    throw new Error(message);
  }

  return payload.secure_url as string;
}

export async function uploadFileToCloudinary(file: File) {
  validateConfig();

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset as string);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
    {
      method: "POST",
      body: formData,
    }
  );

  const payload = await response.json();

  if (!response.ok) {
    const message = mapCloudinaryError(
      response.status,
      payload,
      "Cloudinary file upload failed."
    );
    throw new Error(message);
  }

  return payload.secure_url as string;
}

let googleMapsApiPromise: Promise<typeof google.maps> | null = null;

async function ensureMapsReady(): Promise<typeof google.maps> {
  const timeoutAt = Date.now() + 10000;

  while (Date.now() < timeoutAt) {
    const maps = window.google?.maps;
    if (!maps) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 100);
      });
      continue;
    }

    if (typeof maps.Map === "function") {
      return maps;
    }

    if (typeof maps.importLibrary === "function") {
      try {
        await maps.importLibrary("maps");
      } catch {
        // Retry until timeout to handle transient script initialization states.
      }

      if (typeof maps.Map === "function") {
        return maps;
      }
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 100);
    });
  }

  throw new Error("Google Maps Map constructor is unavailable.");
}

export function loadGoogleMapsApi(): Promise<typeof google.maps> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps is only available in the browser."));
  }

  if (window.google?.maps) {
    return ensureMapsReady();
  }

  if (googleMapsApiPromise) {
    return googleMapsApiPromise;
  }

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) {
    return Promise.reject(new Error("Missing VITE_GOOGLE_MAPS_API_KEY."));
  }

  googleMapsApiPromise = new Promise<typeof google.maps>((resolve, reject) => {
    const existingScript = document.getElementById("google-maps-js");
    if (existingScript) {
      if (window.google?.maps) {
        void ensureMapsReady().then(resolve).catch(reject);
        return;
      }

      existingScript.addEventListener("load", () => {
        void ensureMapsReady().then(resolve).catch(reject);
      });
      existingScript.addEventListener("error", () => {
        reject(new Error("Failed to load Google Maps script."));
      });
      return;
    }

    const script = document.createElement("script");
    script.id = "google-maps-js";
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&libraries=marker,routes`;

    script.onload = () => {
      void ensureMapsReady().then(resolve).catch(reject);
    };

    script.onerror = () => {
      reject(new Error("Failed to load Google Maps script."));
    };

    document.head.appendChild(script);
  });

  return googleMapsApiPromise;
}

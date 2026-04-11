let googleMapsApiPromise: Promise<typeof google.maps> | null = null;

export function loadGoogleMapsApi(): Promise<typeof google.maps> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps is only available in the browser."));
  }

  if (window.google?.maps) {
    return Promise.resolve(window.google.maps);
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
      existingScript.addEventListener("load", () => {
        if (window.google?.maps) {
          resolve(window.google.maps);
          return;
        }
        reject(new Error("Google Maps script loaded without maps namespace."));
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
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;

    script.onload = () => {
      if (window.google?.maps) {
        resolve(window.google.maps);
        return;
      }
      reject(new Error("Google Maps script loaded without maps namespace."));
    };

    script.onerror = () => {
      reject(new Error("Failed to load Google Maps script."));
    };

    document.head.appendChild(script);
  });

  return googleMapsApiPromise;
}

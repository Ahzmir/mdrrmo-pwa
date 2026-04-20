# MDRRMO PWA

## Firebase Setup

1. Copy `.env.example` to `.env`.
2. Fill in the `VITE_FIREBASE_*` values using your Firebase **web app** config.
3. Fill in `VITE_CLOUDINARY_CLOUD_NAME` and `VITE_CLOUDINARY_UPLOAD_PRESET` for uploads.
: `VITE_CLOUDINARY_UPLOAD_PRESET` must be an **Unsigned** upload preset name (not API key/secret).
4. Run `npm install` if needed, then `npm run dev`.

Build/deploy note:
- `npm run dev` and `npm run build` now run an env preflight check.
- If deployment is built in CI, set the same `VITE_FIREBASE_*` variables in CI secrets/environment (because `.env` files are gitignored).

Firebase is initialized in `src/lib/firebase.ts` and loaded from `src/main.tsx`.
Resident sign-up verification files (ID/proof documents) and incident photos are uploaded to Cloudinary and stored as URLs.

Important: do not put Firebase service-account JSON keys in this frontend project. Service-account credentials must stay on a backend/server only.

## Semaphore SMS Fallback

Offline incident submissions now queue locally and sync through a Firebase callable function (`submitSmsFallbackReport`) that sends via Semaphore.

Set these Cloud Functions environment variables before deploying functions:

- `SEMAPHORE_API_KEY`
- `SMS_FALLBACK_NUMBER`
- `SEMAPHORE_SENDERNAME` (optional; defaults to `MDRRMO`)

For local emulation, copy `functions/.env.example` to `functions/.env` and fill the same values.

Example (Firebase CLI):

```bash
firebase functions:secrets:set SEMAPHORE_API_KEY
firebase functions:secrets:set SMS_FALLBACK_NUMBER
```

`SEMAPHORE_SENDERNAME` can be set via `functions/.env` (or runtime env) if you need a custom sender name.

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

## SMS Fallback (SMSMobileAPI)

Offline incident submissions now queue locally and sync through a Firebase callable function (`submitSmsFallbackReport`) that sends via SMSMobileAPI.

Set these Cloud Functions environment variables before deploying functions:

- `SIM_INBOUND_TOKEN` (required for SIM-bridge inbound webhook auth)

For local emulation, copy `functions/.env.example` to `functions/.env` and fill the same values.

Example (Firebase CLI):

```bash
firebase functions:secrets:set SIM_INBOUND_TOKEN
```

SMS destination is currently defined in `functions/index.js` as `SMSMOBILEAPI_DESTINATION`.

## SIM Bridge Inbound SMS

If hotline SMS is received on a regular SIM, use the `simInboundSms` HTTPS function as the bridge target:

`https://us-central1-<your-project-id>.cloudfunctions.net/simInboundSms`

Required auth:
- Header `x-bridge-token: <SIM_INBOUND_TOKEN>` (or `Authorization: Bearer <SIM_INBOUND_TOKEN>`)

Accepted payload fields:
- Sender: `from`, `From`, `sender`, or `number`
- Message body: `body`, `Body`, `message`, or `text`
- Optional metadata: `messageId`/`smsId`, `receivedAt`/`timestamp`

When accepted, the function writes to `incoming_sms` and `smsInbox`, so admin SMS view and incident auto-conversion continue to work.

## SMSMobileAPI Inbound Webhook

If SMSMobileAPI is receiving inbound SMS, set its webhook URL to:

`https://us-central1-<your-project-id>.cloudfunctions.net/smsmobileapiInboundSms`

Required auth:
- Header `x-api-key: <SIM_INBOUND_TOKEN>` (or `x-bridge-token` / `Authorization: Bearer <SIM_INBOUND_TOKEN>`)

When accepted, the message is written to `incoming_sms` and `smsInbox` for admin-side conversion to an incident.

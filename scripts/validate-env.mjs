import process from "node:process";
import { loadEnv } from "vite";

const mode = process.argv[2] || process.env.NODE_ENV || "development";
const root = process.cwd();
const env = loadEnv(mode, root, "");

const required = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

const missing = required.filter((key) => !env[key]);

if (missing.length > 0) {
  const modeFile = `.env.${mode}`;

  console.error(
    [
      `Missing required Firebase environment values for mode "${mode}": ${missing.join(", ")}`,
      `Add them in .env, ${modeFile}, or your shell/CI environment, then rebuild.`,
    ].join("\n")
  );

  process.exit(1);
}

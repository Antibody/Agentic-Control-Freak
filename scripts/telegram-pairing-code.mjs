import { loadEnvFiles } from "./load-env-file.mjs";
import { resolveTelegramEndpoint } from "./telegram-shared.mjs";

loadEnvFiles();

const { appUrl, workerToken } = resolveTelegramEndpoint();
const role = process.argv[2] ?? "operator";

const response = await fetch(`${appUrl}/api/telegram-control/pairing`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${workerToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ role }),
});
const json = await response.json().catch(() => ({}));
if (!response.ok || json.ok !== true) {
  throw new Error(typeof json.error === "string" ? json.error : `Pairing request failed with HTTP ${response.status}`);
}

console.log(`Pairing code: ${json.data.code}`);
console.log(`Role: ${json.data.role}`);
console.log(`Expires: ${json.data.expiresAt}`);
console.log(`Send this to the bot: ${json.data.usage}`);

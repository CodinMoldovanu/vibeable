import { buildApp, closeApp } from "../app.js";

const app = buildApp();
const body = {
  organizationName: process.env.BOOTSTRAP_ORG,
  name: process.env.BOOTSTRAP_NAME,
  email: process.env.BOOTSTRAP_EMAIL,
  password: process.env.BOOTSTRAP_PASSWORD,
  providerName: process.env.BOOTSTRAP_PROVIDER_NAME,
  providerUrl: process.env.BOOTSTRAP_PROVIDER_URL,
  providerModel: process.env.BOOTSTRAP_PROVIDER_MODEL,
  apiKey: process.env.BOOTSTRAP_PROVIDER_API_KEY
};

const response = await app.inject({ method: "POST", url: "/api/auth/bootstrap", payload: body });
if (response.statusCode >= 300) {
  process.stderr.write(`${response.statusCode}: ${response.body}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Bootstrap owner and organization created.\n");
}
await app.close();
await closeApp();

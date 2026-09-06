import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { startDemo } from "./demo.js";
import { startServer } from "./server.js";
import { Store } from "./store.js";
import { Access } from "./access.js";
import { targetPolicy } from "./network.js";
import {
  acquireLease,
  createBackup,
  verifyBackup,
  restoreBackup,
} from "./operations.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      name: { type: "string" },
      owner: { type: "string" },
      target: { type: "string", multiple: true },
      input: { type: "string" },
      output: { type: "string" },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help) {
    console.log(`Launch Inspector 0.2.0

node dist/cli.js                       Start local or hosted mode
node dist/cli.js doctor                Check runtime prerequisites
node dist/cli.js org-create --name NAME --owner EMAIL --target HTTPS_ORIGIN
node dist/cli.js org-list              List provisioned organizations
node dist/cli.js backup --output NEW_DIRECTORY
node dist/cli.js verify-backup --input BACKUP_DIRECTORY
node dist/cli.js restore --input BACKUP_DIRECTORY --output NEW_DATA_DIRECTORY

Runtime: Node.js >=24.13; npm run build; npx playwright install chromium
Defaults: INSPECTOR_MODE=local, INSPECTOR_PORT=8795, INSPECTOR_DEMO_PORT=8796
INSPECTOR_DATA_DIR defaults to ~/.app-launch-inspector.

Hosted mode requires INSPECTOR_PUBLIC_URL (HTTPS), INSPECTOR_OIDC_ISSUER,
INSPECTOR_OIDC_CLIENT_ID and INSPECTOR_OIDC_CLIENT_SECRET or its _FILE variant.
INSPECTOR_HOST defaults to 127.0.0.1. Use a trusted TLS reverse proxy for hosting.
Stop the service before organization provisioning, backup or restore.
See docs/HOSTING.md for deployment and docs/OPERATIONS.md for recovery.`);
    return;
  }
  const dataDir = resolve(
    process.env.INSPECTOR_DATA_DIR ??
      resolve(homedir(), ".app-launch-inspector"),
  );
  const required = (name: "input" | "output" | "name" | "owner") => {
    const value = values[name];
    if (!value) throw Error(`Provide --${name}`);
    return value;
  };
  if (command === "backup") {
    console.log(
      JSON.stringify(createBackup(dataDir, required("output")), null, 2),
    );
    return;
  }
  if (command === "verify-backup") {
    const manifest = verifyBackup(required("input"));
    console.log(
      JSON.stringify(
        {
          verified: true,
          files: manifest.files.length,
          createdAt: manifest.createdAt,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "restore") {
    console.log(
      JSON.stringify(
        restoreBackup(required("input"), required("output")),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "org-create" || command === "org-list") {
    const store = new Store(dataDir);
    let lease: ReturnType<typeof acquireLease> | undefined;
    try {
      const access = new Access(store.database);
      if (command === "org-list")
        console.log(JSON.stringify(access.organizations(), null, 2));
      else {
        lease = acquireLease(store.database);
        const origins = values.target ?? [];
        for (const origin of origins) await targetPolicy(origin, [], false);
        console.log(
          JSON.stringify(
            access.createOrganization(
              required("name"),
              required("owner"),
              origins,
            ),
            null,
            2,
          ),
        );
      }
    } finally {
      lease?.release();
      store.close();
    }
    return;
  }
  const mode = process.env.INSPECTOR_MODE ?? "local";
  if (!["local", "hosted"].includes(mode))
    throw Error("INSPECTOR_MODE must be local or hosted");
  const hosted = mode === "hosted";
  const settings = hosted
    ? {
        issuer: process.env.INSPECTOR_OIDC_ISSUER ?? "",
        clientId: process.env.INSPECTOR_OIDC_CLIENT_ID ?? "",
        clientSecret: process.env.INSPECTOR_OIDC_CLIENT_SECRET_FILE
          ? readFileSync(
              process.env.INSPECTOR_OIDC_CLIENT_SECRET_FILE,
              "utf8",
            ).trim()
          : (process.env.INSPECTOR_OIDC_CLIENT_SECRET ?? ""),
        requiredAcr: process.env.INSPECTOR_OIDC_REQUIRED_ACR,
      }
    : undefined;
  if (command === "doctor") {
    const checks = [
      {
        name: "Node.js 24.13+",
        ok:
          Number(process.versions.node.split(".")[0]) > 24 ||
          (Number(process.versions.node.split(".")[0]) === 24 &&
            Number(process.versions.node.split(".")[1]) >= 13),
      },
      {
        name: "Built dashboard",
        ok: existsSync(resolve("ui-dist/index.html")),
      },
      { name: "Chromium installed", ok: existsSync(chromium.executablePath()) },
      {
        name: "Hosted identity settings",
        ok:
          !hosted ||
          !!(
            settings?.issuer &&
            settings.clientId &&
            settings.clientSecret &&
            process.env.INSPECTOR_PUBLIC_URL
          ),
      },
    ];
    console.log(JSON.stringify({ mode, checks }, null, 2));
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
    return;
  }
  if (command !== "serve") throw Error("Unknown command. Use --help.");
  if (
    hosted &&
    (!settings?.issuer || !settings.clientId || !settings.clientSecret)
  )
    throw Error(
      "Hosted mode requires the OIDC issuer, client ID and client secret",
    );
  const port = Number(process.env.INSPECTOR_PORT ?? 8795),
    demoPort = Number(process.env.INSPECTOR_DEMO_PORT ?? 8796);
  if (
    ![port, demoPort].every(
      (p) => Number.isInteger(p) && p >= 1024 && p <= 65535,
    ) ||
    port === demoPort
  )
    throw Error("Choose two different ports between 1024 and 65535");
  const demo = hosted ? undefined : await startDemo(demoPort);
  try {
    const app = await startServer({
      port,
      demoOrigin: demo?.origin,
      dataDir,
      mode: hosted ? "hosted" : "local",
      host: process.env.INSPECTOR_HOST ?? "127.0.0.1",
      publicOrigin: process.env.INSPECTOR_PUBLIC_URL,
      oidc: settings,
    });
    console.log(
      `Launch Inspector: ${app.origin}\nMode: ${mode}${demo ? "\nControlled sample app: " + demo.origin : ""}`,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      await demo?.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  } catch (error) {
    await demo?.close();
    throw error;
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

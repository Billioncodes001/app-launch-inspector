import { homedir } from "node:os";
import { resolve } from "node:path";
import { startDemo } from "./demo.js";
import { startServer } from "./server.js";

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Launch Inspector\n\nStart: npm start\n\nINSPECTOR_PORT=8795\nINSPECTOR_DEMO_PORT=8796\nINSPECTOR_DATA_DIR=~/.app-launch-inspector\n\nThe control server binds to 127.0.0.1. Inspect only staging/test applications you are authorized to exercise.",
    );
    return;
  }
  const port = Number(process.env.INSPECTOR_PORT ?? 8795),
    demoPort = Number(process.env.INSPECTOR_DEMO_PORT ?? 8796);
  if (
    ![port, demoPort].every(
      (p) => Number.isInteger(p) && p >= 1024 && p <= 65535,
    ) ||
    port === demoPort
  )
    throw Error("Choose two different ports between 1024 and 65535");
  const demo = await startDemo(demoPort);
  try {
    const app = await startServer({
      port,
      demoOrigin: demo.origin,
      dataDir: resolve(
        process.env.INSPECTOR_DATA_DIR ??
          resolve(homedir(), ".app-launch-inspector"),
      ),
    });
    console.log(
      `Launch Inspector: ${app.origin}\nControlled sample app: ${demo.origin}`,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      await demo.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  } catch (error) {
    await demo.close();
    throw error;
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

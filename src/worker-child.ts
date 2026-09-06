import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserEngine } from "./browser-engine.js";
import { workerJobSchema, type WorkerEvent } from "./worker-protocol.js";
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
const lifetime = setTimeout(() => abort.abort(), 180000);
async function send(event: WorkerEvent) {
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(event) + "\n", (e) =>
      e ? reject(e) : resolve(),
    ),
  );
}
let directory: string | undefined;
try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 256000) throw Error("Worker request is too large");
    chunks.push(chunk);
  }
  const job = workerJobSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  directory = process.env.INSPECTOR_JOB_DIR;
  if (!directory) throw Error("Worker job directory is missing");
  const engine = new BrowserEngine(directory, {
    stepTimeoutMs: job.stepTimeoutMs,
  });
  await engine.run(job, abort.signal, async (result) => {
    const evidence = result.screenshots.map((s) => {
      const bytes = readFileSync(join(directory!, s.file));
      if (bytes.length > 3 * 1024 * 1024)
        throw Error("Screenshot exceeds the evidence limit");
      return { file: s.file, data: bytes.toString("base64") };
    });
    await send({ type: "result", result, evidence });
  });
  await send({ type: "done" });
} catch (error) {
  await send({
    type: "error",
    message:
      error instanceof Error
        ? error.message.slice(0, 1600)
        : "Inspection worker failed",
  }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  clearTimeout(lifetime);
}

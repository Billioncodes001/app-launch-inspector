import { readFileSync } from "node:fs";
try {
  const token = process.env.INSPECTOR_WORKER_TOKEN_FILE
    ? readFileSync(process.env.INSPECTOR_WORKER_TOKEN_FILE, "utf8").trim()
    : process.env.INSPECTOR_WORKER_TOKEN;
  if (!token) throw Error("Missing worker token");
  const response = await fetch(
    `http://127.0.0.1:${process.env.INSPECTOR_WORKER_PORT ?? 8799}/healthz`,
    {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    },
  );
  await response.body?.cancel();
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}

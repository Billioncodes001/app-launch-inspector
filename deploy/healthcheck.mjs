import { request } from "node:http";
const origin = process.env.INSPECTOR_PUBLIC_URL;
if (!origin) process.exit(1);
const req = request(
  {
    host: "127.0.0.1",
    port: Number(process.env.INSPECTOR_PORT ?? 8795),
    path: "/healthz",
    headers: { Host: new URL(origin).host },
    timeout: 4000,
  },
  (res) => {
    res.resume();
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  },
);
req.on("timeout", () => req.destroy());
req.on("error", () => {
  process.exitCode = 1;
});
req.end();

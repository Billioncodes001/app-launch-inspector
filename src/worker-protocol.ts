import { z } from "zod";
import { projectSchema, networkDiagnosticsSchema } from "./contracts.js";
export const workerJobSchema = z
  .object({
    project: projectSchema,
    runId: z.string().uuid(),
    forbiddenPorts: z.array(z.number().int().min(1).max(65535)).max(20),
    allowLoopback: z.boolean(),
    sandbox: z.boolean(),
    stepTimeoutMs: z.number().int().min(50).max(15000),
  })
  .strict();
export type WorkerJob = z.infer<typeof workerJobSchema>;
const text = z.string().max(2000);
export const workerEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("result"),
      result: z.object({
        index: z.number().int().min(0).max(11),
        name: text,
        kind: z.enum(["page", "login", "access", "journey"]),
        status: z.enum(["passed", "failed", "inconclusive", "skipped"]),
        severity: z.enum(["high", "medium", "info"]),
        summary: text,
        expected: text,
        observed: text,
        recommendation: text,
        steps: z.array(text).max(150),
        durationMs: z.number().nonnegative(),
        screenshots: z
          .array(
            z.object({ file: z.string().regex(/^\d+-\d+\.png$/), label: text }),
          )
          .max(4),
        warnings: z.array(text).max(12),
        network: networkDiagnosticsSchema.optional(),
      }),
      evidence: z
        .array(
          z.object({
            file: z.string().regex(/^\d+-\d+\.png$/),
            data: z.string().max(4 * 1024 * 1024),
          }),
        )
        .max(4),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z.object({ type: z.literal("error"), message: text }).strict(),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export function browserEnvironment() {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "DISPLAY",
    "XAUTHORITY",
    "LANG",
    "LC_ALL",
    "FONTCONFIG_PATH",
    "XDG_CACHE_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
  ];
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        allowed.some((k) => k.toLowerCase() === key.toLowerCase()),
    ),
  ) as Record<string, string>;
}

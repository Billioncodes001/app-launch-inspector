import { z } from "zod";

const label = z.string().trim().min(1).max(160);
export const pathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => {
    try {
      return (
        value.startsWith("/") &&
        new URL(value, "https://scope.invalid").origin ===
          "https://scope.invalid" &&
        !value.includes("\\")
      );
    } catch {
      return false;
    }
  }, "Use a path on this target, starting with /");
export const accountSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
    name: label,
    username: z.string().min(1).max(200),
    password: z.string().max(500),
  })
  .strict();
export const loginSchema = z
  .object({
    path: pathSchema,
    usernameLabel: label,
    passwordLabel: label,
    button: label,
    successPath: pathSchema,
    successText: label,
    errorText: z.string().max(160).default(""),
  })
  .strict();
export const stepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("visit"), path: pathSchema }).strict(),
  z
    .object({ action: z.literal("fill"), label, value: z.string().max(1000) })
    .strict(),
  z
    .object({
      action: z.literal("click"),
      label,
      role: z.enum(["button", "link"]).default("button"),
    })
    .strict(),
  z.object({ action: z.literal("expect"), text: label }).strict(),
]);
export const checkSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      name: label,
      path: pathSchema,
      expectedText: label,
    })
    .strict(),
  z
    .object({
      kind: z.literal("login"),
      name: label,
      account: label,
      rejectInvalid: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("access"),
      name: label,
      path: pathSchema,
      owner: label,
      actor: label,
      expectedText: label,
      deniedText: z.string().max(160).default("Access denied"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("journey"),
      name: label,
      account: z.string().max(30).default(""),
      steps: z.array(stepSchema).min(1).max(12),
    })
    .strict(),
]);
export const projectSchema = z
  .object({
    name: label,
    baseUrl: z.string().url().max(300),
    repository: z.string().max(300).default(""),
    login: loginSchema,
    accounts: z.array(accountSchema).max(6),
    checks: z.array(checkSchema).min(1).max(12),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const u = new URL(value.baseUrl);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/"
      )
        throw Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message:
          "Use an HTTP(S) origin without a path, credentials, query or fragment",
      });
    }
    if (
      value.repository &&
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(
        value.repository,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["repository"],
        message: "Use a GitHub repository URL without a query or credentials",
      });
    const ids = new Set(value.accounts.map((a) => a.id));
    if (ids.size !== value.accounts.length || ids.has("anonymous"))
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: "Account IDs must be unique and cannot be anonymous",
      });
    value.checks.forEach((check, i) => {
      const required =
        check.kind === "login"
          ? [check.account]
          : check.kind === "access"
            ? [
                check.owner,
                ...(check.actor === "anonymous" ? [] : [check.actor]),
              ]
            : check.kind === "journey" && check.account
              ? [check.account]
              : [];
      if (required.some((id) => !ids.has(id)))
        ctx.addIssue({
          code: "custom",
          path: ["checks", i],
          message: "Choose an existing test account",
        });
      if (check.kind === "access" && check.owner === check.actor)
        ctx.addIssue({
          code: "custom",
          path: ["checks", i],
          message: "The owner and restricted actor must differ",
        });
      if (
        check.kind === "journey" &&
        !check.steps.some((step) => step.action === "expect")
      )
        ctx.addIssue({
          code: "custom",
          path: ["checks", i],
          message: "A journey needs at least one visible-text assertion",
        });
    });
  });
export type ProjectInput = z.infer<typeof projectSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Project = ProjectInput & {
  id: string;
  revision: string;
  updatedAt: string;
  demo?: "broken" | "fixed";
};
export type PublicProject = Omit<Project, "accounts"> & {
  accounts: Array<
    z.infer<typeof accountSchema> & { passwordConfigured: boolean }
  >;
};
export type ResultStatus = "passed" | "failed" | "inconclusive" | "skipped";
export type CheckResult = {
  index: number;
  name: string;
  kind: Check["kind"];
  status: ResultStatus;
  severity: "high" | "medium" | "info";
  summary: string;
  expected: string;
  observed: string;
  recommendation: string;
  steps: string[];
  durationMs: number;
  screenshots: Array<{ file: string; label: string }>;
  warnings: string[];
};
export type Run = {
  id: string;
  projectId: string;
  projectName: string;
  projectRevision: string;
  target: string;
  repository: string;
  demo?: "broken" | "fixed";
  status: "queued" | "running" | "completed" | "cancelled" | "interrupted";
  createdAt: string;
  finishedAt?: string;
  total: number;
  results: CheckResult[];
  error?: string;
  authorizedAt: string;
};

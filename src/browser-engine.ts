import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProjectInput, Check, CheckResult } from "./contracts.js";
import { inScope, pathUrl, targetPolicy } from "./network.js";
import { browserEnvironment, type WorkerJob } from "./worker-protocol.js";
import { resultSummary, resultGuidance } from "./result-presentation.js";
class Finding extends Error {}
export class BrowserEngine {
  constructor(
    readonly evidenceDir: string,
    readonly options: { stepTimeoutMs?: number } = {},
  ) {}
  async run(
    job: WorkerJob,
    signal: AbortSignal,
    onResult: (result: CheckResult) => Promise<void>,
  ) {
    const project = job.project;
    const secrets = [
      ...project.accounts.map((a) => a.password),
      ...project.checks.flatMap((c) =>
        c.kind === "journey"
          ? c.steps.flatMap((s) => (s.action === "fill" ? [s.value] : []))
          : [],
      ),
    ].filter(Boolean);
    const redact = (text: string) =>
      secrets
        .reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text)
        .slice(0, 1600);
    const policy = await targetPolicy(
      project.baseUrl,
      job.forbiddenPorts,
      job.allowLoopback,
    );
    if (signal.aborted) throw Error("Inspection cancelled");
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
      chromiumSandbox: job.sandbox,
      env: browserEnvironment(),
      args: [
        ...(policy.resolverRule
          ? [`--host-resolver-rules=${policy.resolverRule}`]
          : []),
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-features=DnsOverHttps,UseDnsHttpsSvcb",
      ],
    });
    const cancel = () => {
      void browser.close().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (let index = 0; index < project.checks.length; index++) {
        if (signal.aborted) throw Error("Inspection cancelled");
        await onResult(
          await this.inspect(
            browser,
            project,
            project.checks[index],
            index,
            redact,
          ),
        );
      }
    } catch (error) {
      throw Error(
        redact(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      await browser.close().catch(() => undefined);
    }
  }
  private async inspect(
    browser: Browser,
    project: ProjectInput,
    check: Check,
    index: number,
    redact: (s: string) => string,
  ) {
    const started = Date.now();
    const contexts: BrowserContext[] = [];
    let current: Page | undefined;
    let constrained = false;
    const result: CheckResult = {
      index,
      name: check.name,
      kind: check.kind,
      status: "inconclusive",
      severity: check.kind === "access" ? "high" : "medium",
      summary: "",
      expected: "",
      observed: "",
      recommendation: "",
      steps: [],
      durationMs: 0,
      screenshots: [],
      warnings: [],
    };
    const log = (s: string) => result.steps.push(redact(s));
    const warning = (s: string) => {
      if (result.warnings.length < 12 && !result.warnings.includes(s))
        result.warnings.push(s);
    };
    const blocked = (
      url: string,
      resourceType: string,
      reason: NonNullable<
        CheckResult["network"]
      >["destinations"][number]["reason"],
    ) => {
      constrained = true;
      result.network ??= { blocked: 0, destinations: [], truncated: false };
      result.network.blocked++;
      // Keep origins only: URL paths, queries and fragments may contain secrets.
      let origin = "Non-HTTP destination";
      try {
        const parsed = new URL(url);
        if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol))
          origin = redact(parsed.origin).slice(0, 350);
      } catch {}
      const entry = result.network.destinations.find(
        (d) =>
          d.origin === origin &&
          d.resourceType === resourceType &&
          d.reason === reason,
      );
      if (entry) entry.count++;
      else if (result.network.destinations.length < 16)
        result.network.destinations.push({
          origin,
          resourceType,
          reason,
          count: 1,
        });
      else result.network.truncated = true;
      warning(
        reason === "websocket"
          ? "WebSockets are not supported in this inspection."
          : reason === "request_budget"
            ? "The browser session exceeded its 250-request limit."
            : "A request was blocked outside the configured target origin.",
      );
    };
    const textVisible = async (page: Page, text: string, wait = false) => {
      try {
        const locator = page
          .getByText(text, { exact: false })
          .filter({ visible: true })
          .first();
        if (wait)
          await locator.waitFor({
            state: "visible",
            timeout: this.options.stepTimeoutMs ?? 6000,
          });
        return await locator.isVisible();
      } catch {
        return false;
      }
    };
    const capture = async (page: Page, label: string) => {
      const file = `${index}-${result.screenshots.length}.png`;
      try {
        await page.screenshot({
          path: join(this.evidenceDir, file),
          fullPage: false,
          animations: "disabled",
          timeout: 4000,
          mask: [
            page.locator("input,textarea,[data-private],[data-sensitive]"),
            ...project.accounts.map((a) =>
              page.getByText(a.password, { exact: true }),
            ),
          ],
          maskColor: "#cbd5e1",
        });
        result.screenshots.push({ file, label });
      } catch {
        warning("Screenshot could not be captured.");
      }
    };
    const open = async () => {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      contexts.push(ctx);
      let requests = 0;
      await ctx.route("**/*", async (route) => {
        const request = route.request(),
          outside = !inScope(request.url(), project.baseUrl);
        requests++;
        if (outside || requests > 250) {
          blocked(
            request.url(),
            request.resourceType(),
            outside ? "outside_origin" : "request_budget",
          );
          await route.abort().catch(() => undefined);
          return;
        }
        await route.continue().catch(() => undefined);
      });
      await ctx.routeWebSocket("**/*", (socket) => {
        blocked(socket.url(), "websocket", "websocket");
        socket.close();
      });
      ctx.on("page", (page) => {
        page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
      });
      current = await ctx.newPage();
      current.setDefaultTimeout(this.options.stepTimeoutMs ?? 6000);
      current.setDefaultNavigationTimeout(15000);
      return current;
    };
    const visit = async (page: Page, path: string) => {
      log(`Navigate to ${path.split("?")[0]}`);
      const response = await page.goto(pathUrl(path, project.baseUrl), {
        waitUntil: "domcontentloaded",
      });
      if (!response || response.status() >= 500)
        throw Error("The target did not return a usable page");
      return response.status();
    };
    const login = async (page: Page, id: string, invalid = false) => {
      const account = project.accounts.find((a) => a.id === id);
      if (!account) throw Error("Test account is missing");
      await visit(page, project.login.path);
      log(
        `Sign in as ${account.name}${invalid ? " with one intentionally invalid password" : ""} (credentials redacted)`,
      );
      await page
        .getByLabel(project.login.usernameLabel, { exact: true })
        .fill(account.username);
      await page
        .getByLabel(project.login.passwordLabel, { exact: true })
        .fill(invalid ? randomUUID() : account.password);
      await page
        .getByRole("button", { name: project.login.button, exact: true })
        .click();
      if (!invalid) {
        await page.waitForURL(
          (u) =>
            u.origin === project.baseUrl &&
            u.pathname ===
              new URL(project.login.successPath, project.baseUrl).pathname,
        );
        if (!(await textVisible(page, project.login.successText, true)))
          throw Error(
            "The signed-in success marker was not visible. Confirm login settings and test credentials.",
          );
        log("Confirmed the configured signed-in URL and text");
      }
    };
    try {
      if (check.kind === "page") {
        result.expected = `The page shows “${check.expectedText}”.`;
        const page = await open();
        const status = await visit(page, check.path);
        if (status >= 400)
          throw new Finding(`The page returned HTTP ${status}.`);
        if (!(await textVisible(page, check.expectedText, true)))
          throw new Finding("The expected page content was not visible.");
        result.observed = "Expected content is visible.";
        result.summary = "Page content confirmed";
      } else if (check.kind === "login") {
        result.expected =
          "Valid credentials reach the configured signed-in page.";
        const page = await open();
        await login(page, check.account);
        await capture(page, "Successful sign-in");
        if (check.rejectInvalid) {
          if (!project.login.errorText)
            throw Error(
              "An invalid-login rejection message must be configured for this check.",
            );
          const denied = await open();
          await login(denied, check.account, true);
          if (await textVisible(denied, project.login.errorText, true)) {
            log("The configured invalid-password rejection is visible");
          } else if (
            new URL(denied.url()).pathname ===
              new URL(project.login.successPath, project.baseUrl).pathname &&
            (await textVisible(denied, project.login.successText))
          )
            throw new Finding(
              "The intentionally invalid password reached the signed-in page.",
            );
          else
            throw Error(
              "Invalid credentials produced neither the configured rejection nor a confirmed signed-in state.",
            );
        }
        result.observed = check.rejectInvalid
          ? "Valid login succeeded and invalid login was explicitly rejected."
          : "The signed-in URL and success marker were confirmed.";
        result.summary = "Login behavior confirmed";
      } else if (check.kind === "access") {
        result.expected = `${check.actor === "anonymous" ? "A signed-out visitor" : project.accounts.find((a) => a.id === check.actor)?.name} cannot see “${check.expectedText}”.`;
        const owner = await open();
        await login(owner, check.owner);
        const ownerStatus = await visit(owner, check.path);
        if (
          ownerStatus >= 400 ||
          !(await textVisible(owner, check.expectedText, true))
        )
          throw Error(
            "The authorized baseline could not see the protected marker. No permission conclusion was made.",
          );
        log("Authorized baseline confirmed protected content");
        await capture(owner, "Authorized baseline");
        const actor = await open();
        if (check.actor !== "anonymous") await login(actor, check.actor);
        else log("Use a new, signed-out browser context");
        const status = await visit(actor, check.path);
        if (await textVisible(actor, check.expectedText, true))
          throw new Finding(
            "Protected content was visible to the restricted actor.",
          );
        const redirected =
          new URL(actor.url()).pathname ===
          new URL(project.login.path, project.baseUrl).pathname;
        if (
          ![401, 403, 404].includes(status) &&
          !redirected &&
          !(check.deniedText && (await textVisible(actor, check.deniedText)))
        )
          throw Error(
            "Content was absent, but no configured denial, login redirect or denied HTTP status was observed.",
          );
        result.observed = `The authorized baseline succeeded. The restricted actor received ${redirected ? "a login redirect" : status >= 400 ? "HTTP " + status : "the configured denial message"}.`;
        result.summary = "Access boundary held";
      } else {
        result.expected = "The configured journey completes all assertions.";
        const page = await open();
        if (check.account) await login(page, check.account);
        for (const step of check.steps) {
          if (step.action === "visit") await visit(page, step.path);
          else if (step.action === "fill") {
            log(`Fill the “${step.label}” field (value redacted)`);
            await page.getByLabel(step.label, { exact: true }).fill(step.value);
          } else if (step.action === "click") {
            log(`Activate ${step.role} “${step.label}”`);
            await page
              .getByRole(step.role, { name: step.label, exact: true })
              .click();
          } else {
            log(`Verify visible text “${step.text}”`);
            if (!(await textVisible(page, step.text, true)))
              throw new Finding(
                `The journey did not show expected text “${step.text}”.`,
              );
          }
        }
        result.observed =
          "All configured steps and visible-text assertions completed.";
        result.summary = "Customer journey completed";
      }
      result.status = result.warnings.length ? "inconclusive" : "passed";
      result.severity = "info";
      result.recommendation = result.warnings.length
        ? "Resolve blocked dependencies and rerun this check before relying on it."
        : "Keep this check in the release suite; it covers only the configured scenario.";
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : String(error),
      );
      result.status = error instanceof Finding ? "failed" : "inconclusive";
      result.summary =
        result.status === "failed"
          ? "Observed behavior did not meet the check"
          : "Check needs investigation";
      result.observed = message;
      result.recommendation =
        check.kind === "access" && result.status === "failed"
          ? "Enforce authorization on the server for this resource and actor. Do not rely on hiding navigation. Rerun both the authorized and restricted cases after fixing it."
          : result.status === "failed"
            ? "Reproduce these steps on the test deployment, inspect the corresponding handler and persistence behavior, then rerun after the change."
            : "Check target availability, login labels, account roles and assertion text. An inconclusive check is not evidence that access is secure.";
    } finally {
      if (current) await capture(current, "Observed result");
      for (const ctx of contexts) await ctx.close().catch(() => undefined);
      // A blocked dependency can explain a missing page/journey assertion.
      // Observed unauthorized access remains a finding even if a request was blocked.
      if (
        (result.status === "passed" && result.warnings.length) ||
        (result.status === "failed" &&
          constrained &&
          (check.kind === "page" || check.kind === "journey"))
      ) {
        result.status = "inconclusive";
        result.severity = "info";
        result.summary = "Check needs investigation";
        result.recommendation =
          "Review the recorded warnings and rerun before relying on this check.";
      }
      result.summary = resultSummary(result);
      result.recommendation = resultGuidance(result);
      result.durationMs = Date.now() - started;
      // Redact every textual result, including user-supplied check labels and expectations.
      for (const key of [
        "name",
        "summary",
        "expected",
        "observed",
        "recommendation",
      ] as const)
        result[key] = redact(result[key]);
      result.steps = result.steps.map(redact);
      result.warnings = result.warnings.map(redact);
    }
    return result;
  }
}

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Project, Run, Check, CheckResult } from "./contracts.js";
import { Store } from "./store.js";
import { inScope, pathUrl, targetPolicy } from "./network.js";

class Finding extends Error {}
export class Runner {
  private queue: Array<{ run: Run; project: Project }> = [];
  private current?: {
    run: Run;
    browser?: Browser;
    cancelled: boolean;
    timedOut: boolean;
    done: Promise<void>;
  };
  private closing = false;
  constructor(
    readonly store: Store,
    readonly controlPort: number,
    readonly options: { timeoutMs?: number; stepTimeoutMs?: number } = {},
  ) {
    store.recover();
  }
  async enqueue(project: Project) {
    if (this.closing) throw Error("Runner is stopping");
    if (this.queue.length + (this.current ? 1 : 0) >= 5)
      throw Error("The local inspection queue is full");
    await targetPolicy(project.baseUrl, [this.controlPort]);
    // Recheck after asynchronous DNS validation to enforce the queue bound.
    if (this.queue.length + (this.current ? 1 : 0) >= 5)
      throw Error("The local inspection queue is full");
    const run = this.store.createRun(project);
    this.queue.push({ run, project: structuredClone(project) });
    void this.pump();
    return run;
  }
  async cancel(id: string) {
    const item = this.queue.find((q) => q.run.id === id);
    if (item) {
      this.queue = this.queue.filter((q) => q !== item);
      item.run.status = "cancelled";
      item.run.finishedAt = new Date().toISOString();
      this.store.saveRun(item.run);
      return;
    }
    if (this.current?.run.id === id) {
      this.current.cancelled = true;
      await this.current.browser?.close();
      return;
    }
    throw Error("Only queued or running inspections can be cancelled");
  }
  async close() {
    this.closing = true;
    for (const item of [...this.queue]) await this.cancel(item.run.id);
    const active = this.current;
    if (active) {
      await this.cancel(active.run.id);
      await active.done;
    }
  }
  private async pump() {
    if (this.current || this.closing) return;
    const item = this.queue.shift();
    if (!item) return;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const { run, project } = item;
    const active = {
      run,
      browser: undefined as Browser | undefined,
      cancelled: false,
      timedOut: false,
      done,
    };
    this.current = active;
    const secrets = [
      ...project.accounts.map((a) => a.password),
      ...project.checks.flatMap((c) =>
        c.kind === "journey"
          ? c.steps
              .filter((s) => s.action === "fill")
              .map((s) => (s.action === "fill" ? s.value : ""))
          : [],
      ),
    ].filter(Boolean);
    const redact = (text: string) =>
      secrets
        .reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text)
        .slice(0, 1600);
    const timeout = setTimeout(() => {
      active.timedOut = true;
      void active.browser?.close();
    }, this.options.timeoutMs ?? 180000);
    try {
      run.status = "running";
      this.store.saveRun(run);
      const policy = await targetPolicy(project.baseUrl, [this.controlPort]);
      if (active.cancelled || active.timedOut) return;
      active.browser = await chromium.launch({
        channel: "chromium",
        headless: true,
        args: [
          ...(policy.resolverRule
            ? [`--host-resolver-rules=${policy.resolverRule}`]
            : []),
          "--disable-quic",
          "--disable-features=DnsOverHttps,UseDnsHttpsSvcb",
        ],
      });
      if (active.cancelled || active.timedOut) return;
      for (let index = 0; index < project.checks.length; index++) {
        if (active.cancelled || active.timedOut) break;
        const result = await this.inspect(
          active.browser,
          project,
          project.checks[index],
          index,
          run,
          redact,
        );
        run.results.push(result);
        this.store.saveRun(run);
      }
    } catch (error) {
      run.error = redact(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timeout);
      await active.browser?.close().catch(() => undefined);
      run.status = active.cancelled
        ? "cancelled"
        : active.timedOut || run.error
          ? "interrupted"
          : "completed";
      if (active.timedOut)
        run.error =
          "Inspection reached its time budget. Remaining checks were not run.";
      run.finishedAt = new Date().toISOString();
      this.store.saveRun(run);
      this.current = undefined;
      complete();
      if (!this.closing) void this.pump();
    }
  }
  private async inspect(
    browser: Browser,
    project: Project,
    check: Check,
    index: number,
    run: Run,
    redact: (s: string) => string,
  ) {
    const started = Date.now();
    const contexts: BrowserContext[] = [];
    let current: Page | undefined;
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
          path: join(this.store.runDir(run.id), file),
          fullPage: false,
          animations: "disabled",
          timeout: 4000,
          mask: [
            page.locator("input,textarea,[data-private],[data-sensitive]"),
            ...project.accounts.map((a) =>
              page.getByText(a.password, { exact: true }),
            ),
          ],
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
        if (
          !inScope(route.request().url(), project.baseUrl) ||
          ++requests > 250
        ) {
          warning(
            "A request was blocked outside the target origin or request budget.",
          );
          await route.abort().catch(() => undefined);
          return;
        }
        await route.continue().catch(() => undefined);
      });
      await ctx.routeWebSocket("**/*", (socket) => {
        warning("WebSockets are not supported in this inspection.");
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
      // Requests can be blocked while the final evidence is being captured.
      if (result.status === "passed" && result.warnings.length) {
        result.status = "inconclusive";
        result.summary = "Check needs investigation";
        result.recommendation =
          "Review the recorded warnings and rerun before relying on this check.";
      }
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
export function reportMarkdown(run: Run) {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "");
  return (
    `# Launch Inspector report\n\nProject: ${clean(run.projectName)}\n\nTarget: ${run.target}\n\nRun: ${run.id}\n\nConfiguration revision: ${run.projectRevision}\n\nStatus: ${run.status}\n\n${run.demo ? "This run used the intentionally controlled demonstration app.\n\n" : ""}` +
    run.results
      .map(
        (r) =>
          `## ${r.index + 1}. ${clean(r.name)} — ${r.status}\n\nExpected: ${clean(r.expected)}\n\nObserved: ${clean(r.observed)}\n\n${r.steps.map((s, i) => `${i + 1}. ${clean(s)}`).join("\n")}\n\nRecommendation: ${clean(r.recommendation)}\n\nWarnings: ${r.warnings.map(clean).join("; ") || "None recorded"}\n`,
      )
      .join("\n") +
    "\nThese bounded browser observations are not a security certification or a complete application audit.\n"
  );
}

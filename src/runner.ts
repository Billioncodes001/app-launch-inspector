import type { Project, Run, Actor } from "./contracts.js";
import { executeInspection, type WorkerConnection } from "./worker-client.js";
import { Store } from "./store.js";
import { targetPolicy } from "./network.js";
import { BrowserCapacity } from "./capacity.js";
import { localActor } from "./database.js";

export class Runner {
  private queue: Array<{
    run: Run;
    project: Project;
    actor: Actor;
    release: () => void;
  }> = [];
  private current?: {
    run: Run;
    cancelled: boolean;
    timedOut: boolean;
    done: Promise<void>;
    abort: AbortController;
  };
  private closing = false;
  private faulted = false;
  get healthy() {
    return !this.faulted;
  }
  constructor(
    readonly store: Store,
    readonly controlPort: number,
    readonly options: {
      timeoutMs?: number;
      stepTimeoutMs?: number;
      capacity?: BrowserCapacity;
      allowLoopback?: boolean;
      sandbox?: boolean;
      worker?: WorkerConnection;
      authorize?: (project: Project, actor: Actor) => void;
    } = {},
  ) {
    store.recover();
  }
  async enqueue(project: Project, actor: Actor = localActor) {
    if (this.closing || this.faulted) throw Error("Runner is unavailable");
    this.options.authorize?.(project, actor);
    if (this.queue.length + (this.current ? 1 : 0) >= 5)
      throw Error("The local inspection queue is full");
    await targetPolicy(
      project.baseUrl,
      [this.controlPort],
      this.options.allowLoopback,
    );
    // Recheck after asynchronous DNS validation to enforce the queue bound.
    if (this.queue.length + (this.current ? 1 : 0) >= 5)
      throw Error("The local inspection queue is full");
    const release = this.options.capacity?.reserve() ?? (() => {});
    try {
      const run = this.store.createRun(project, actor);
      this.queue.push({
        run,
        project: structuredClone(project),
        actor,
        release,
      });
      void this.pump();
      return run;
    } catch (error) {
      release();
      throw error;
    }
  }
  async cancel(id: string) {
    const item = this.queue.find((q) => q.run.id === id);
    if (item) {
      this.queue = this.queue.filter((q) => q !== item);
      item.run.status = "cancelled";
      item.run.finishedAt = new Date().toISOString();
      try {
        this.store.saveRun(item.run);
      } finally {
        item.release();
      }
      return;
    }
    if (this.current?.run.id === id) {
      this.current.cancelled = true;
      this.current.abort.abort();
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
    const { run, project, actor } = item;
    const active = {
      run,
      cancelled: false,
      timedOut: false,
      done,
      abort: new AbortController(),
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
      active.abort.abort();
    }, this.options.timeoutMs ?? 180000);
    let releaseBrowser: (() => void) | undefined;
    try {
      releaseBrowser = await this.options.capacity?.acquire(
        active.abort.signal,
      );
      this.options.authorize?.(project, actor);
      run.status = "running";
      this.store.saveRun(run);
      const { id, revision, updatedAt, demo, ...input } = project;
      await executeInspection(
        {
          project: input,
          runId: run.id,
          forbiddenPorts: [this.controlPort],
          allowLoopback: this.options.allowLoopback ?? true,
          sandbox: this.options.sandbox ?? false,
          stepTimeoutMs: this.options.stepTimeoutMs ?? 6000,
        },
        {
          signal: active.abort.signal,
          connection: this.options.worker,
          directory: this.store.runDir(run.id),
          onResult: (result) => {
            run.results.push(result);
            this.store.saveRun(run);
          },
        },
      );
    } catch (error) {
      run.error = redact(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timeout);
      run.status = active.cancelled
        ? "cancelled"
        : active.timedOut || run.error
          ? "interrupted"
          : "completed";
      if (active.timedOut)
        run.error =
          "Inspection reached its time budget. Remaining checks were not run.";
      run.finishedAt = new Date().toISOString();
      try {
        this.store.saveRun(run);
      } catch {
        this.faulted = true;
      } finally {
        releaseBrowser?.();
        item.release();
        this.current = undefined;
        complete();
      }
      if (!this.closing && !this.faulted) void this.pump();
    }
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
    (Object.keys(run.review ?? {}).length
      ? "\n## Review decisions\n\n" +
        Object.entries(run.review ?? {})
          .map(
            ([index, review]) =>
              `Check ${Number(index) + 1}: ${review.status.replaceAll("_", " ")} by ${clean(review.actor)} at ${review.updatedAt}\n\n${clean(review.note)}\n`,
          )
          .join("\n") +
        "\nReview decisions do not change the original check results.\n"
      : "") +
    (run.hold
      ? `\n## Evidence retention hold\n\n${clean(run.hold.note)}\n\nRecorded by ${clean(run.hold.actor)} at ${run.hold.createdAt}.\n`
      : "") +
    "\nThese bounded browser observations are not a security certification or a complete application audit.\n"
  );
}

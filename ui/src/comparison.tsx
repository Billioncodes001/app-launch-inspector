import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Run } from "../../src/contracts";
import { compatibleRuns, type RunComparison } from "../../src/comparison";
import { request, headers } from "./client";

export function Comparison({ run, runs }: { run: Run; runs: Run[] }) {
  const candidates = runs.filter((r) => compatibleRuns(r, run));
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState("");
  const selected = candidates.some((r) => r.id === baseline) ? baseline : "";
  const path = `/runs/${selected}/compare/${run.id}`;
  const query = useQuery<RunComparison>({
    queryKey: ["comparison", selected, run.id],
    queryFn: () => request(path),
    enabled: !!selected,
    retry: false,
  });
  async function download() {
    setError("");
    try {
      const response = await fetch(`/api${path}?export=json`, {
        headers: headers(),
      });
      if (!response.ok)
        throw Error(
          "Comparison export unavailable. Reload and check access to both runs.",
        );
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `comparison-${selected}-${run.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="run-comparison" aria-label="Saved run comparison">
      <h3>What changed?</h3>
      <p>
        Compare this run with an earlier finished run of the same saved
        configuration. No checks are rerun.
      </p>
      <label>
        Baseline run
        <select
          value={selected}
          onChange={(e) => {
            setBaseline(e.target.value);
            setError("");
          }}
        >
          <option value="">
            {candidates.length
              ? "Choose a baseline"
              : "No compatible earlier runs"}
          </option>
          {candidates.map((r) => (
            <option key={r.id} value={r.id}>
              {new Date(r.createdAt).toLocaleString()} · {r.id.slice(0, 8)} ·{" "}
              {r.status}
            </option>
          ))}
        </select>
      </label>
      {selected && query.isPending && (
        <p role="status">Comparing saved observations...</p>
      )}
      {(query.error || error) && (
        <p role="alert">{error || query.error?.message}</p>
      )}
      {selected && query.data && (
        <>
          <p className="comparison-counts">
            {Object.entries(query.data.counts).map(([key, value]) => (
              <span key={key}>
                <b>{value}</b> {key}
              </span>
            ))}
          </p>
          <ul>
            {query.data.checks.map((c) => (
              <li key={c.index}>
                <strong>{c.name}</strong>
                <span>
                  {c.from} → {c.to}
                </span>
                <b>{c.change}</b>
              </li>
            ))}
          </ul>
          <p>{query.data.limits}</p>
          <button
            className="button secondary small"
            onClick={() => void download()}
          >
            Export comparison JSON
          </button>
        </>
      )}
    </section>
  );
}

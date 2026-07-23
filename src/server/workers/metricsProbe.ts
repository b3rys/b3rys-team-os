import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { insertMetric, pruneMetrics, latestMetric } from "../db/queries";
import type { Broadcaster } from "./types";

const POLL_INTERVAL_MS = 30_000;

async function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(out));
  });
}

async function topSnapshot(): Promise<{ cpu: number | null; mem: number | null }> {
  const out = await runCmd("/usr/bin/top", ["-l", "1", "-n", "0", "-s", "0"]);
  let cpu: number | null = null;
  let mem: number | null = null;
  for (const line of out.split("\n")) {
    const cpuMatch = line.match(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/);
    if (cpuMatch) {
      cpu = parseFloat(cpuMatch[1] ?? "0") + parseFloat(cpuMatch[2] ?? "0");
    }
    const memMatch = line.match(/PhysMem:\s*([\d.]+)([GMK]) used/);
    if (memMatch) {
      const val = parseFloat(memMatch[1] ?? "0");
      const unit = memMatch[2];
      mem = unit === "G" ? val * 1024 : unit === "M" ? val : val / 1024;
    }
  }
  return { cpu, mem: mem == null ? null : Math.round(mem) };
}

async function load1min(): Promise<number | null> {
  const out = await runCmd("/usr/sbin/sysctl", ["-n", "vm.loadavg"]);
  const m = out.match(/{\s*([\d.]+)/);
  return m ? parseFloat(m[1] ?? "0") : null;
}

async function ollamaRunning(): Promise<boolean> {
  const out = await runCmd("/usr/bin/pgrep", ["-x", "ollama"]);
  return out.trim().length > 0;
}

export function startMetricsProbe(db: Database, broadcast: Broadcaster): () => void {
  let stopped = false;

  const probe = async () => {
    if (stopped) return;
    const [{ cpu, mem }, load, ollama] = await Promise.all([
      topSnapshot(),
      load1min(),
      ollamaRunning(),
    ]);
    insertMetric(db, {
      cpu_percent: cpu,
      mem_used_mb: mem,
      load_1min: load,
      ollama_running: ollama,
    });
    pruneMetrics(db);
    const m = latestMetric(db);
    if (m) broadcast({ type: "metric", metric: m });
  };

  void probe();
  const interval = setInterval(() => void probe(), POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

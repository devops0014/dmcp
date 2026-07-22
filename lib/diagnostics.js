import { getLogs, inspect } from "./docker.js";
import { stripLeadingSlash } from "./utils.js";

export const healthSummary = (info) => ({
  name: stripLeadingSlash(info.Name),
  status: info.State?.Status,
  running: info.State?.Running,
  paused: info.State?.Paused,
  restarting: info.State?.Restarting,
  restartCount: info.RestartCount,
  exitCode: info.State?.ExitCode,
  oomKilled: info.State?.OOMKilled,
  error: info.State?.Error,
  startedAt: info.State?.StartedAt,
  finishedAt: info.State?.FinishedAt,
  health: info.State?.Health ? {
    status: info.State.Health.Status,
    failingStreak: info.State.Health.FailingStreak,
    recentChecks: (info.State.Health.Log ?? []).slice(-5).map(v => ({ start: v.Start, end: v.End, exitCode: v.ExitCode, output: v.Output }))
  } : null
});

export const diagnoseContainer = async (name, tail = 100) => {
  const info = await inspect(name);
  const health = healthSummary(info);
  const findings = [];
  let severity = "info";
  if (health.oomKilled) { findings.push("Container was OOM-killed."); severity = "critical"; }
  if (health.health?.status === "unhealthy") { findings.push(`Health check is unhealthy with failing streak ${health.health.failingStreak}.`); severity = "critical"; }
  if (health.restarting) { findings.push("Container is currently restarting."); severity = "critical"; }
  if (health.restartCount >= 5) { findings.push(`Container has restarted ${health.restartCount} times.`); severity = severity === "critical" ? severity : "warning"; }
  if (!health.running) { findings.push(`Container is not running; status=${health.status}, exitCode=${health.exitCode}.`); severity = severity === "critical" ? severity : "warning"; }
  if (health.exitCode === 137) findings.push("Exit code 137 commonly indicates SIGKILL, often caused by memory pressure or a forced kill.");
  if (health.exitCode === 143) findings.push("Exit code 143 indicates graceful termination by SIGTERM.");
  const logs = await getLogs(name, { tail, maxBytes: 200000 });
  const lower = logs.toLowerCase();
  if (lower.includes("connection refused")) findings.push("Recent logs contain 'connection refused'; verify dependencies, service address, port and network.");
  if (lower.includes("no space left on device")) { findings.push("Recent logs report no space left on device."); severity = "critical"; }
  if (lower.includes("permission denied")) findings.push("Recent logs contain permission-denied errors; inspect UID/GID, file modes and mounts.");
  if (lower.includes("out of memory") || lower.includes("oom")) findings.push("Recent logs contain memory-related errors.");
  return { container: health.name, severity, findings: findings.length ? findings : ["No obvious failure pattern detected from container state and recent logs."], health, recentLogs: logs };
};

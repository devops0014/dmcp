import { stripLeadingSlash } from "./utils.js";

const SENSITIVE_KEY = /(pass(word)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)/i;
const WRITE_TOOLS = new Set(["start_container", "stop_container", "restart_container", "pause_container", "unpause_container"]);
const protectedNames = new Set((process.env.PROTECTED_CONTAINERS ?? "").split(",").map(v => v.trim()).filter(Boolean));

export const isWriteTool = (name) => WRITE_TOOLS.has(name);

export const sanitizeEnvironment = (entries = []) => entries.map(entry => {
  const separator = entry.indexOf("=");
  const key = separator < 0 ? entry : entry.slice(0, separator);
  const value = separator < 0 ? "" : entry.slice(separator + 1);
  return SENSITIVE_KEY.test(key) ? `${key}=***REDACTED***` : `${key}=${value}`;
});

export const sanitizeInspect = (info) => ({
  id: info.Id?.slice(0, 12),
  name: stripLeadingSlash(info.Name),
  image: info.Config?.Image,
  created: info.Created,
  platform: info.Platform,
  state: info.State,
  restartCount: info.RestartCount,
  environment: sanitizeEnvironment(info.Config?.Env),
  labels: info.Config?.Labels,
  ports: info.NetworkSettings?.Ports,
  networks: info.NetworkSettings?.Networks,
  mounts: (info.Mounts ?? []).map(mount => ({
    type: mount.Type,
    name: mount.Name,
    destination: mount.Destination,
    readOnly: !mount.RW,
    source: mount.Type === "bind" ? "***HOST_PATH_REDACTED***" : undefined
  })),
  restartPolicy: info.HostConfig?.RestartPolicy,
  resources: {
    memory: info.HostConfig?.Memory,
    nanoCpus: info.HostConfig?.NanoCpus,
    cpuShares: info.HostConfig?.CpuShares,
    pidsLimit: info.HostConfig?.PidsLimit
  }
});

export const assertWriteAllowed = (tool, args, info) => {
  if (process.env.ALLOW_WRITE_TOOLS !== "true") throw new Error("Write tools are disabled. Set ALLOW_WRITE_TOOLS=true to enable them.");
  if (process.env.REQUIRE_WRITE_CONFIRMATION !== "false" && args.confirm !== true) throw new Error("Explicit confirmation is required.");
  if (!args.reason || String(args.reason).trim().length < 5) throw new Error("A meaningful reason of at least 5 characters is required.");
  const name = stripLeadingSlash(info.Name);
  const labels = info.Config?.Labels ?? {};
  if (protectedNames.has(name)) throw new Error(`Container '${name}' is protected by PROTECTED_CONTAINERS.`);
  if (labels["mcp.production/protected"] === "true") throw new Error(`Container '${name}' is protected by label.`);
  if (labels["mcp.production/write-allowed"] === "false") throw new Error(`Container '${name}' blocks MCP write operations.`);
  return { tool, name };
};

export const audit = ({ id, tool, target, result, durationMs, error }) => {
  if (process.env.AUDIT_LOG_TO_STDERR === "false") return;
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), requestId: id, tool, target, result, durationMs, error }));
};

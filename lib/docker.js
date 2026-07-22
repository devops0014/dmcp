import Docker from "dockerode";
import { dockerLogBufferToText, readStream, stripLeadingSlash, withTimeout } from "./utils.js";
import { cpuPercent, memoryMetrics } from "./stats.js";

export const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" });
const timeoutMs = Number(process.env.DOCKER_OPERATION_TIMEOUT_MS || 15000);

export const inspect = (name) => withTimeout(docker.getContainer(name).inspect(), timeoutMs, `inspect ${name}`);

export const listContainers = async (all = true) => {
  const containers = await withTimeout(docker.listContainers({ all }), timeoutMs, "list containers");
  return containers.map(c => ({
    id: c.Id.slice(0, 12),
    names: c.Names.map(stripLeadingSlash),
    image: c.Image,
    imageId: c.ImageID,
    command: c.Command,
    created: new Date(c.Created * 1000).toISOString(),
    state: c.State,
    status: c.Status,
    ports: c.Ports,
    labels: c.Labels,
    networks: Object.keys(c.NetworkSettings?.Networks ?? {})
  }));
};

export const getLogs = async (name, { tail = 100, sinceSeconds, timestamps = true, maxBytes = 512000 } = {}) => {
  const options = { stdout: true, stderr: true, tail, timestamps };
  if (sinceSeconds) options.since = Math.floor(Date.now() / 1000) - sinceSeconds;
  const data = await withTimeout(docker.getContainer(name).logs(options), timeoutMs, `logs ${name}`);
  if (Buffer.isBuffer(data)) return dockerLogBufferToText(data.subarray(0, maxBytes));
  const buffer = await readStream(data, maxBytes);
  return dockerLogBufferToText(buffer);
};

export const getStats = async () => {
  const containers = await docker.listContainers();
  const settled = await Promise.allSettled(containers.map(async c => {
    const stats = await withTimeout(docker.getContainer(c.Id).stats({ stream: false }), timeoutMs, `stats ${c.Id}`);
    const memory = memoryMetrics(stats);
    return {
      id: c.Id.slice(0, 12),
      name: stripLeadingSlash(c.Names?.[0]),
      cpuPercent: Number(cpuPercent(stats).toFixed(2)),
      memoryUsageBytes: memory.usageBytes,
      memoryLimitBytes: memory.limitBytes,
      memoryPercent: Number(memory.percent.toFixed(2)),
      pids: stats.pids_stats?.current ?? 0,
      networks: stats.networks ?? {},
      blockIo: stats.blkio_stats ?? {}
    };
  }));
  return settled.map((r, i) => r.status === "fulfilled" ? r.value : ({ id: containers[i].Id.slice(0, 12), error: r.reason.message }));
};

export const recentEvents = async ({ minutes = 30, container, event } = {}) => {
  const filters = {};
  if (container) filters.container = [container];
  if (event) filters.event = [event];
  const since = Math.floor(Date.now() / 1000) - minutes * 60;
  const until = Math.floor(Date.now() / 1000);
  const stream = await docker.getEvents({ since, until, filters });
  const buffer = await readStream(stream, 512000);
  return buffer.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
};

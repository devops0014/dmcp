import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { docker, getLogs, getStats, inspect, listContainers, recentEvents } from "./lib/docker.js";
import { diagnoseContainer, healthSummary } from "./lib/diagnostics.js";
import { assertWriteAllowed, audit, sanitizeInspect } from "./lib/security.js";
import { inspectService, listNodes, listServices, serviceTasks } from "./lib/swarm.js";
import { clamp, envInt, failure, formatBytes, requestId, stripLeadingSlash, success, withTimeout } from "./lib/utils.js";

const MAX_OUTPUT_BYTES = envInt("MAX_OUTPUT_BYTES", 1_000_000, 10_000, 10_000_000);
const MAX_LOG_TAIL = envInt("MAX_LOG_TAIL", 2000, 1, 10000);
const TIMEOUT = envInt("DOCKER_OPERATION_TIMEOUT_MS", 15000, 1000, 120000);
const server = new Server({ name: "production-docker-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });

const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const nameProperty = { name: { type: "string", minLength: 1, maxLength: 256 } };
const writeProperties = { ...nameProperty, reason: { type: "string", minLength: 5, maxLength: 500 }, confirm: { type: "boolean" } };

const tools = [
  { name: "list_containers", description: "List running and stopped Docker containers.", inputSchema: objectSchema({ all: { type: "boolean", default: true } }) },
  { name: "container_logs", description: "Read bounded recent logs from a container.", inputSchema: objectSchema({ ...nameProperty, tail: { type: "integer", minimum: 1, maximum: MAX_LOG_TAIL, default: 100 }, sinceSeconds: { type: "integer", minimum: 1, maximum: 604800 }, timestamps: { type: "boolean", default: true } }, ["name"]) },
  { name: "inspect_container", description: "Inspect a container with secrets and host bind paths redacted.", inputSchema: objectSchema(nameProperty, ["name"]) },
  { name: "container_health", description: "Show health, restart count, exit code and OOM status.", inputSchema: objectSchema(nameProperty, ["name"]) },
  { name: "failed_containers", description: "Find exited, restarting, unhealthy, OOM-killed or repeatedly restarting containers.", inputSchema: objectSchema({ restartThreshold: { type: "integer", minimum: 1, maximum: 1000, default: 3 } }) },
  { name: "container_processes", description: "List processes running inside a container using Docker top.", inputSchema: objectSchema({ ...nameProperty, psArgs: { type: "string", maxLength: 100, default: "aux" } }, ["name"]) },
  { name: "docker_stats", description: "Get CPU, memory, PID, network and block-I/O metrics for running containers.", inputSchema: objectSchema() },
  { name: "docker_events", description: "Read bounded recent Docker lifecycle events.", inputSchema: objectSchema({ minutes: { type: "integer", minimum: 1, maximum: 1440, default: 30 }, container: { type: "string" }, event: { type: "string", enum: ["start", "stop", "die", "restart", "oom", "kill", "health_status"] } }) },
  { name: "docker_system_info", description: "Get filtered Docker Engine and host information.", inputSchema: objectSchema() },
  { name: "docker_disk_usage", description: "Get Docker image, container, volume and build-cache disk usage.", inputSchema: objectSchema() },
  { name: "list_images", description: "List Docker images and sizes.", inputSchema: objectSchema({ all: { type: "boolean", default: true } }) },
  { name: "list_volumes", description: "List Docker volumes without reading their contents.", inputSchema: objectSchema() },
  { name: "list_networks", description: "List Docker networks.", inputSchema: objectSchema() },
  { name: "inspect_network", description: "Inspect a Docker network and attached containers.", inputSchema: objectSchema(nameProperty, ["name"]) },
  { name: "container_port_mappings", description: "Show published and exposed ports for a container.", inputSchema: objectSchema(nameProperty, ["name"]) },
  { name: "container_network_connections", description: "Show a container's Docker network attachments and addresses.", inputSchema: objectSchema(nameProperty, ["name"]) },
  { name: "diagnose_container", description: "Correlate state, health and recent logs into troubleshooting findings.", inputSchema: objectSchema({ ...nameProperty, tail: { type: "integer", minimum: 1, maximum: 500, default: 100 } }, ["name"]) },
  { name: "list_services", description: "List Docker Swarm services. Returns an error when Swarm is unavailable.", inputSchema: objectSchema() },
  { name: "inspect_service", description: "Inspect a Docker Swarm service.", inputSchema: objectSchema(nameProperty, ["name"]) },
  { name: "service_tasks", description: "List tasks for a Docker Swarm service.", inputSchema: objectSchema({ service: { type: "string", minLength: 1 } }, ["service"]) },
  { name: "list_nodes", description: "List Docker Swarm nodes.", inputSchema: objectSchema() },
  { name: "start_container", description: "Start an approved container. Disabled by default and requires reason plus confirmation.", inputSchema: objectSchema(writeProperties, ["name", "reason", "confirm"]) },
  { name: "stop_container", description: "Gracefully stop an approved container.", inputSchema: objectSchema({ ...writeProperties, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120, default: 30 } }, ["name", "reason", "confirm"]) },
  { name: "restart_container", description: "Restart an approved container.", inputSchema: objectSchema({ ...writeProperties, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120, default: 30 } }, ["name", "reason", "confirm"]) },
  { name: "pause_container", description: "Pause an approved container.", inputSchema: objectSchema(writeProperties, ["name", "reason", "confirm"]) },
  { name: "unpause_container", description: "Unpause an approved container.", inputSchema: objectSchema(writeProperties, ["name", "reason", "confirm"]) }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const id = requestId();
  const started = Date.now();
  const tool = request.params.name;
  const args = request.params.arguments ?? {};
  const target = args.name ?? args.service;
  try {
    let result;
    if (tool === "list_containers") result = await listContainers(args.all !== false);
    else if (tool === "container_logs") result = await getLogs(args.name, { tail: clamp(args.tail, 1, MAX_LOG_TAIL, 100), sinceSeconds: args.sinceSeconds, timestamps: args.timestamps !== false, maxBytes: envInt("MAX_LOG_BYTES", 512000, 10000, 5000000) });
    else if (tool === "inspect_container") result = sanitizeInspect(await inspect(args.name));
    else if (tool === "container_health") result = healthSummary(await inspect(args.name));
    else if (tool === "failed_containers") {
      const threshold = clamp(args.restartThreshold, 1, 1000, 3);
      const containers = await docker.listContainers({ all: true });
      const details = await Promise.all(containers.map(c => inspect(c.Id)));
      result = details.map(healthSummary).filter(h => !h.running || h.restarting || h.oomKilled || h.health?.status === "unhealthy" || h.restartCount >= threshold);
    }
    else if (tool === "container_processes") result = await withTimeout(docker.getContainer(args.name).top({ ps_args: args.psArgs || "aux" }), TIMEOUT, `top ${args.name}`);
    else if (tool === "docker_stats") result = await getStats();
    else if (tool === "docker_events") result = await recentEvents({ minutes: clamp(args.minutes, 1, 1440, Number(process.env.DEFAULT_EVENT_MINUTES || 30)), container: args.container, event: args.event });
    else if (tool === "docker_system_info") {
      const info = await withTimeout(docker.info(), TIMEOUT, "docker info");
      const version = await withTimeout(docker.version(), TIMEOUT, "docker version");
      result = { name: info.Name, serverVersion: version.Version, apiVersion: version.ApiVersion, operatingSystem: info.OperatingSystem, architecture: info.Architecture, kernelVersion: info.KernelVersion, containers: info.Containers, containersRunning: info.ContainersRunning, containersStopped: info.ContainersStopped, images: info.Images, driver: info.Driver, cgroupDriver: info.CgroupDriver, cgroupVersion: info.CgroupVersion, ncpu: info.NCPU, memoryBytes: info.MemTotal, memoryHuman: formatBytes(info.MemTotal), securityOptions: info.SecurityOptions, swarm: info.Swarm };
    }
    else if (tool === "docker_disk_usage") result = await withTimeout(docker.df(), TIMEOUT, "docker disk usage");
    else if (tool === "list_images") result = (await docker.listImages({ all: args.all !== false })).map(i => ({ id: i.Id?.replace("sha256:", "").slice(0, 12), repoTags: i.RepoTags, repoDigests: i.RepoDigests, created: new Date(i.Created * 1000).toISOString(), sizeBytes: i.Size, sizeHuman: formatBytes(i.Size), sharedSizeBytes: i.SharedSize, containers: i.Containers }));
    else if (tool === "list_volumes") result = await docker.listVolumes();
    else if (tool === "list_networks") result = (await docker.listNetworks()).map(n => ({ id: n.Id?.slice(0, 12), name: n.Name, driver: n.Driver, scope: n.Scope, internal: n.Internal, attachable: n.Attachable, ingress: n.Ingress, ipam: n.IPAM, labels: n.Labels }));
    else if (tool === "inspect_network") result = await withTimeout(docker.getNetwork(args.name).inspect(), TIMEOUT, `inspect network ${args.name}`);
    else if (tool === "container_port_mappings") { const i = await inspect(args.name); result = { container: stripLeadingSlash(i.Name), exposedPorts: i.Config?.ExposedPorts, bindings: i.NetworkSettings?.Ports }; }
    else if (tool === "container_network_connections") { const i = await inspect(args.name); result = { container: stripLeadingSlash(i.Name), hostname: i.Config?.Hostname, networks: i.NetworkSettings?.Networks }; }
    else if (tool === "diagnose_container") result = await diagnoseContainer(args.name, clamp(args.tail, 1, 500, 100));
    else if (tool === "list_services") result = await listServices();
    else if (tool === "inspect_service") result = await inspectService(args.name);
    else if (tool === "service_tasks") result = await serviceTasks(args.service);
    else if (tool === "list_nodes") result = await listNodes();
    else if (["start_container", "stop_container", "restart_container", "pause_container", "unpause_container"].includes(tool)) {
      const container = docker.getContainer(args.name);
      const info = await inspect(args.name);
      assertWriteAllowed(tool, args, info);
      const seconds = clamp(args.timeoutSeconds, 1, 120, 30);
      if (tool === "start_container") await withTimeout(container.start(), TIMEOUT, `start ${args.name}`);
      if (tool === "stop_container") await withTimeout(container.stop({ t: seconds }), TIMEOUT + seconds * 1000, `stop ${args.name}`);
      if (tool === "restart_container") await withTimeout(container.restart({ t: seconds }), TIMEOUT + seconds * 1000, `restart ${args.name}`);
      if (tool === "pause_container") await withTimeout(container.pause(), TIMEOUT, `pause ${args.name}`);
      if (tool === "unpause_container") await withTimeout(container.unpause(), TIMEOUT, `unpause ${args.name}`);
      result = { operation: tool, container: stripLeadingSlash(info.Name), reason: args.reason, success: true };
    } else return failure(`Unknown tool: ${tool}`, "UNKNOWN_TOOL");
    audit({ id, tool, target, result: "success", durationMs: Date.now() - started });
    return success(result, MAX_OUTPUT_BYTES);
  } catch (error) {
    audit({ id, tool, target, result: "failure", durationMs: Date.now() - started, error: error.message });
    return failure(error.message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(JSON.stringify({ level: "info", message: "Production Docker MCP server started", writeToolsEnabled: process.env.ALLOW_WRITE_TOOLS === "true" }));

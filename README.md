# Production Docker MCP Server

A modular Docker MCP server for container discovery, observability, troubleshooting, guarded lifecycle actions, and Docker Swarm visibility.

## Safety defaults

- Write tools are disabled by default.
- Write tools require `confirm: true` and a reason.
- Protected containers can be configured by name or labels.
- Sensitive environment variables and host bind paths are redacted from container inspection.
- Logs and MCP responses are bounded.
- Audit logs are written to stderr so they do not corrupt stdio MCP traffic.

## Requirements

- Node.js 20+
- Docker Engine or Docker Desktop
- Access to the Docker socket

## Install

```bash
cp .env.example .env
npm install
npm run check
npm start
```

## Claude Desktop configuration

```json
{
  "mcpServers": {
    "docker-mcp": {
      "command": "node",
      "args": ["/absolute/path/docker-mcp/script.js"],
      "env": {
        "DOCKER_SOCKET": "/var/run/docker.sock",
        "ALLOW_WRITE_TOOLS": "false",
        "REQUIRE_WRITE_CONFIRMATION": "true",
        "PROTECTED_CONTAINERS": "docker-mcp,traefik,prometheus,grafana"
      }
    }
  }
}
```

## Enable controlled write operations

Use only after testing in a non-production environment:

```bash
ALLOW_WRITE_TOOLS=true npm start
```

A restart call requires arguments similar to:

```json
{
  "name": "payment-api",
  "timeoutSeconds": 30,
  "reason": "Health check is failing and logs were reviewed",
  "confirm": true
}
```

## Protection labels

```yaml
labels:
  mcp.production/protected: "true"
  mcp.production/write-allowed: "false"
```

## Included tools

Container tools: `list_containers`, `container_logs`, `inspect_container`, `container_health`, `failed_containers`, `container_processes`, `docker_stats`, `container_port_mappings`, `container_network_connections`, `diagnose_container`.

Docker tools: `docker_events`, `docker_system_info`, `docker_disk_usage`, `list_images`, `list_volumes`, `list_networks`, `inspect_network`.

Swarm tools: `list_services`, `inspect_service`, `service_tasks`, `list_nodes`.

Guarded operations: `start_container`, `stop_container`, `restart_container`, `pause_container`, `unpause_container`.

## Important production note

Access to the Docker socket is highly privileged. Run this MCP server only on trusted hosts and clients, preferably through a tightly controlled service account or isolated management host. Do not expose it directly to the public internet.

import { docker } from "./docker.js";
import { withTimeout } from "./utils.js";

const timeoutMs = Number(process.env.DOCKER_OPERATION_TIMEOUT_MS || 15000);

export const listServices = async () => {
  const services = await withTimeout(docker.listServices(), timeoutMs, "list swarm services");
  return services.map(s => ({ id: s.ID?.slice(0, 12), name: s.Spec?.Name, image: s.Spec?.TaskTemplate?.ContainerSpec?.Image, mode: s.Spec?.Mode, updateStatus: s.UpdateStatus, serviceStatus: s.ServiceStatus, version: s.Version?.Index }));
};

export const inspectService = async (name) => withTimeout(docker.getService(name).inspect(), timeoutMs, `inspect service ${name}`);

export const serviceTasks = async (service) => {
  const tasks = await withTimeout(docker.listTasks({ filters: { service: [service] } }), timeoutMs, `tasks ${service}`);
  return tasks.map(t => ({ id: t.ID?.slice(0, 12), serviceId: t.ServiceID?.slice(0, 12), nodeId: t.NodeID?.slice(0, 12), desiredState: t.DesiredState, state: t.Status?.State, message: t.Status?.Message, error: t.Status?.Err, containerId: t.Status?.ContainerStatus?.ContainerID?.slice(0, 12) }));
};

export const listNodes = async () => {
  const nodes = await withTimeout(docker.listNodes(), timeoutMs, "list swarm nodes");
  return nodes.map(n => ({ id: n.ID?.slice(0, 12), hostname: n.Description?.Hostname, role: n.Spec?.Role, availability: n.Spec?.Availability, state: n.Status?.State, managerStatus: n.ManagerStatus, engineVersion: n.Description?.Engine?.EngineVersion }));
};

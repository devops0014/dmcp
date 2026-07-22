export const cpuPercent = (stats) => {
  const current = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const previous = stats.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const systemCurrent = stats.cpu_stats?.system_cpu_usage ?? 0;
  const systemPrevious = stats.precpu_stats?.system_cpu_usage ?? 0;
  const cpuDelta = current - previous;
  const systemDelta = systemCurrent - systemPrevious;
  const online = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  return cpuDelta > 0 && systemDelta > 0 ? (cpuDelta / systemDelta) * online * 100 : 0;
};

export const memoryMetrics = (stats) => {
  const usage = stats.memory_stats?.usage ?? 0;
  const cache = stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0;
  const actual = Math.max(usage - cache, 0);
  const limit = stats.memory_stats?.limit ?? 0;
  return { usageBytes: actual, limitBytes: limit, percent: limit > 0 ? (actual / limit) * 100 : 0 };
};

import crypto from "node:crypto";

export const envInt = (name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

export const clamp = (value, min, max, fallback = min) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

export const requestId = () => crypto.randomUUID();

export const withTimeout = async (promise, ms, label = "operation") => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const stripLeadingSlash = (value = "") => value.replace(/^\//, "");

export const truncateUtf8 = (value, maxBytes) => {
  const text = String(value ?? "");
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[truncated]`;
};

export const formatBytes = (bytes = 0) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

export const success = (data, maxBytes = 1_000_000) => ({
  content: [{ type: "text", text: truncateUtf8(typeof data === "string" ? data : JSON.stringify(data, null, 2), maxBytes) }]
});

export const failure = (message, code = "DOCKER_OPERATION_FAILED") => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }, null, 2) }]
});

export const readStream = async (stream, maxBytes) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    const remaining = maxBytes - size;
    if (remaining <= 0) break;
    chunks.push(buffer.subarray(0, remaining));
    size += Math.min(buffer.length, remaining);
  }
  return Buffer.concat(chunks);
};

export const dockerLogBufferToText = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return String(buffer ?? "");
  const output = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    if ((streamType !== 0 && streamType !== 1 && streamType !== 2) || offset + 8 + length > buffer.length) {
      return buffer.toString("utf8");
    }
    output.push(buffer.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    offset += 8 + length;
  }
  return output.length ? output.join("") : buffer.toString("utf8");
};

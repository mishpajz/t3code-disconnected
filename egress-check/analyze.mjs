// Turns the DNS log and packet capture into a report and fails on anything not
// in allowlist.txt.
// Usage: node analyze.mjs <out-dir> <allowlist>
import * as NodeFS from "node:fs";

const [outDir, allowlistPath] = process.argv.slice(2);
const readLines = (file) =>
  NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

const allowlist = readLines(allowlistPath)
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean);
const allowed = (value) =>
  allowlist.some((entry) =>
    entry.startsWith("*.")
      ? value.endsWith(entry.slice(1)) || value === entry.slice(2)
      : value === entry,
  );

const lookups = new Map();
for (const line of readLines(`${outDir}/dns.jsonl`)) {
  const { at, name, type } = JSON.parse(line);
  const entry = lookups.get(name) ?? { name, types: new Set(), count: 0, first: at };
  entry.types.add(type);
  entry.count += 1;
  lookups.set(name, entry);
}

// tcpdump -nn -tttt: `<date> <time> eth0  Out IP 172.18.0.2.40000 > 1.2.3.4.443: Flags [S], ...`
// The capture filter only lets through TCP SYNs and UDP, so anything without
// TCP flags is UDP (tcpdump names well-known UDP protocols instead of "UDP").
const connections = new Map();
for (const line of readLines(`${outDir}/packets.txt`)) {
  const match = line.match(/^(\S+ \S+) .*IP \S+ > (\d+\.\d+\.\d+\.\d+)\.(\d+): (Flags \[)?/);
  if (!match) continue;
  const [, at, ip, port, tcpFlags] = match;
  const key = `${ip}:${port}`;
  const entry = connections.get(key) ?? {
    ip,
    port,
    protocol: tcpFlags ? "tcp" : "udp",
    count: 0,
    first: at,
  };
  entry.count += 1;
  connections.set(key, entry);
}

const lookupList = [...lookups.values()].map((entry) => ({
  ...entry,
  types: [...entry.types].sort(),
}));
const connectionList = [...connections.values()];
const violations = [
  ...lookupList.filter((entry) => !allowed(entry.name)).map((entry) => `DNS ${entry.name}`),
  ...connectionList
    .filter((entry) => !allowed(entry.ip))
    .map((entry) => `${entry.protocol.toUpperCase()} ${entry.ip}:${entry.port}`),
];

NodeFS.writeFileSync(
  `${outDir}/report.json`,
  JSON.stringify({ lookups: lookupList, connections: connectionList, violations }, null, 2) + "\n",
);

console.log(`\nDNS lookups (${lookupList.length}):`);
for (const entry of lookupList.sort((a, b) => a.first.localeCompare(b.first))) {
  console.log(
    `  ${allowed(entry.name) ? "allowed " : "BLOCKED "} ${entry.name}  [${entry.types.join(",")}] x${entry.count}  first ${entry.first}`,
  );
}
console.log(`\nOutbound connection attempts (${connectionList.length}):`);
for (const entry of connectionList) {
  console.log(
    `  ${allowed(entry.ip) ? "allowed " : "BLOCKED "} ${entry.protocol} ${entry.ip}:${entry.port} x${entry.count}  first ${entry.first}`,
  );
}
console.log(
  violations.length === 0
    ? "\nPASS: no outbound traffic outside the allowlist."
    : `\nFAIL: ${violations.length} outbound destination(s) outside the allowlist.`,
);
process.exit(violations.length === 0 ? 0 : 1);

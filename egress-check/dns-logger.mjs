// Minimal DNS server for the egress check: logs every query as a JSON line and
// answers NXDOMAIN, so nothing resolves and every lookup is recorded.
// Usage: node dns-logger.mjs <log-file>
import * as NodeDgram from "node:dgram";
import * as NodeFS from "node:fs";

const logFile = process.argv[2];
const TYPES = {
  1: "A",
  5: "CNAME",
  12: "PTR",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  33: "SRV",
  65: "HTTPS",
};

function readQuestion(msg) {
  const labels = [];
  let offset = 12;
  while (offset < msg.length && msg[offset] !== 0) {
    const len = msg[offset];
    labels.push(msg.subarray(offset + 1, offset + 1 + len).toString("ascii"));
    offset += len + 1;
  }
  const end = offset + 5; // zero byte + QTYPE + QCLASS
  const type = msg.readUInt16BE(offset + 1);
  return { name: labels.join(".").toLowerCase(), type: TYPES[type] ?? String(type), end };
}

const socket = NodeDgram.createSocket("udp4");
socket.on("message", (msg, rinfo) => {
  if (msg.length < 17) return;
  let question;
  try {
    question = readQuestion(msg);
  } catch {
    return;
  }
  NodeFS.appendFileSync(
    logFile,
    JSON.stringify({ at: new Date().toISOString(), name: question.name, type: question.type }) +
      "\n",
  );
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // id
  header[2] = 0x80 | (msg[2] & 0x01); // QR, copy RD
  header[3] = 0x80 | 0x03; // RA, NXDOMAIN
  header.writeUInt16BE(1, 4); // QDCOUNT
  socket.send(Buffer.concat([header, msg.subarray(12, question.end)]), rinfo.port, rinfo.address);
});
socket.bind(53, "127.0.0.1", () => console.log("dns logger listening on 127.0.0.1:53"));

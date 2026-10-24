#!/usr/bin/env bash
# Runs inside the egress check container (see compose.yml): starts the DNS
# logger and packet capture, runs `t3 serve`, drives the UI, then reports.
set -euo pipefail

out=/out
here=/app/egress-check
idle_seconds="${EGRESS_IDLE_SECONDS:-360}"
mkdir -p "$out"
# The server and browser run as an unprivileged user and write here too.
chmod 777 "$out"
rm -f "$out"/{dns.jsonl,packets.txt,server.log,drive.log,report.json,ui.png}

# Every lookup goes to our logger, which answers NXDOMAIN.
node "$here/dns-logger.mjs" "$out/dns.jsonl" &
echo "nameserver 127.0.0.1" > /etc/resolv.conf

# The sandbox network has no gateway, so connections to raw IPs would fail
# before any packet leaves. A default route through the bridge makes them send
# a SYN that tcpdump records and Docker's isolation rules then drop.
subnet_route="$(ip -4 route show dev eth0 | head -n 1)"
gateway="$(python3 -c "import ipaddress,sys; print(next(ipaddress.ip_network(sys.argv[1]).hosts()))" "${subnet_route%% *}")"
ip route add default via "$gateway" dev eth0 2>/dev/null || ip route add default dev eth0

tcpdump -i any -nn -l -tttt -U \
  '(tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0 and not dst net 127.0.0.0/8) or (udp and not dst net 127.0.0.0/8)' \
  > "$out/packets.txt" 2> "$out/tcpdump.log" &
tcpdump_pid=$!
sleep 2

# Sanity check: the sandbox must not reach the internet.
if curl -s -m 5 -o /dev/null https://1.1.1.1; then
  echo "ABORT: the sandbox can reach the internet; the network is not isolated." >&2
  exit 2
fi
sleep 1
sanity_lines=$(wc -l < "$out/packets.txt")

home=/tmp/t3home
mkdir -p "$home"
chown t3:t3 "$home"
su t3 -c "cd /tmp && T3CODE_HOME=$home node /app/apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 3773" \
  > "$out/server.log" 2>&1 &
server_pid=$!

pairing_url=""
for _ in $(seq 1 120); do
  pairing_url="$(sed -n 's/.*Pairing URL: \(http[^ ]*\).*/\1/p' "$out/server.log" | head -n 1)"
  [[ -n "$pairing_url" ]] && break
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "The server exited before printing a pairing URL:" >&2
    cat "$out/server.log" >&2
    exit 2
  fi
  sleep 1
done
if [[ -z "$pairing_url" ]]; then
  echo "Timed out waiting for the pairing URL:" >&2
  cat "$out/server.log" >&2
  exit 2
fi

su t3 -c "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH node $here/drive.mjs '$pairing_url' $idle_seconds $out" \
  2>&1 | tee "$out/drive.log" || echo "The UI driver failed; reporting what was captured." >&2

kill "$server_pid" 2>/dev/null || true
sleep 2
kill "$tcpdump_pid" 2>/dev/null || true
wait "$tcpdump_pid" 2>/dev/null || true

# Drop the sanity check's own packets (the curl to 1.1.1.1) from the capture.
tail -n "+$((sanity_lines + 1))" "$out/packets.txt" > "$out/packets.tmp" && mv "$out/packets.tmp" "$out/packets.txt"

node "$here/analyze.mjs" "$out" "$here/allowlist.txt"

// virtresources
// Virtual CPU, RAM, and GPU memory pools with optional networking.
// Runs one child process (host mode) or connects to another (client mode).
// ---------------------------------------------------------

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import net from "net";
import { GPU } from "gpu.js";

// -------------------- CLI Parsing --------------------
function printHelp() {
  console.log(`
Usage:
  node virtresources.js [options] <app> [args...]

Options (at least one of --cpus, --ram, --gpu required unless --connect):

  --cpus <N>       Number of virtual CPU workers
  --ram <MB>       Virtual RAM in megabytes
  --gpu <MB>       Virtual GPU memory in megabytes
  --listen <PORT>  Host mode: accept remote client writes
  --connect <H:P>  Client mode: connect to host:port and send writes
  --autoscale      Enable autoscaling for RAM/GPU pools
  --log            Print worker usage summaries
  --help           Show this help text

Examples:
  Host with RAM and CPU workers:
    node virtresources.js --ram 512 --cpus 4 ./myapp --foo bar

  Host with GPU pool and listen for clients:
    node virtresources.js --gpu 256 --listen 9000 ./serverApp

  Client only, connects and writes to host:
    node virtresources.js --connect 127.0.0.1:9000 --cpus 2
`);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") { flags.help = true; continue; }
    if (a === "--ram") { flags.ramMB = parseInt(argv[++i], 10); continue; }
    if (a === "--gpu") { flags.gpuMB = parseInt(argv[++i], 10); continue; }
    if (a === "--cpus") { flags.vcpus = parseInt(argv[++i], 10); continue; }
    if (a === "--listen") { flags.listen = parseInt(argv[++i], 10); continue; }
    if (a === "--connect") { flags.connect = argv[++i]; continue; }
    if (a === "--autoscale") { flags.autoscale = true; continue; }
    if (a === "--log") { flags.log = true; continue; }
    else positional.push(a);
  }
  return { flags, positional };
}

function validateFlags(flags, positional) {
  if (flags.help) return; // no validation needed

  // require positive integers
  if (flags.ramMB !== undefined && (!Number.isInteger(flags.ramMB) || flags.ramMB <= 0)) {
    console.error("Error: --ram must be a positive integer (megabytes).");
    process.exit(1);
  }
  if (flags.gpuMB !== undefined && (!Number.isInteger(flags.gpuMB) || flags.gpuMB <= 0)) {
    console.error("Error: --gpu must be a positive integer (megabytes).");
    process.exit(1);
  }
  if (flags.vcpus !== undefined && (!Number.isInteger(flags.vcpus) || flags.vcpus <= 0)) {
    console.error("Error: --cpus must be a positive integer.");
    process.exit(1);
  }
  if (flags.listen !== undefined && (!Number.isInteger(flags.listen) || flags.listen <= 0)) {
    console.error("Error: --listen must be a positive integer port number.");
    process.exit(1);
  }
  if (flags.connect && !/^[^:]+:\d+$/.test(flags.connect)) {
    console.error("Error: --connect must be in host:port format.");
    process.exit(1);
  }

  const inClientMode = !!flags.connect;
  const inHostMode = !!flags.listen || positional.length > 0;

  if (inClientMode && inHostMode) {
    console.error("Error: Cannot use both --connect (client) and host mode flags (--listen or app).");
    process.exit(1);
  }

  if (inHostMode && !inClientMode) {
    if (!flags.vcpus && !flags.ramMB && !flags.gpuMB) {
      console.error("Error: In host mode you must specify at least one resource (--cpus, --ram, or --gpu).");
      process.exit(1);
    }
    if (positional.length === 0) {
      console.error("Error: In host mode you must specify an <app> to run.");
      process.exit(1);
    }
  }

  if (inClientMode && positional.length > 0) {
    console.error("Error: In client mode (--connect) you cannot specify an app to run.");
    process.exit(1);
  }
}

// -------------------- Resource Pools --------------------
class VirtualRAM {
  constructor(sizeMB, autoscale = false) {
    this.size = sizeMB * 1024 * 1024;
    this.buffer = Buffer.alloc(this.size);
    this.autoscale = autoscale;
    console.log(`Virtual RAM initialized (${sizeMB} MB)`);
  }

  write(offset, data) {
    data.copy(this.buffer, offset, 0, Math.min(data.length, this.size - offset));
  }

  read(offset, length) {
    return this.buffer.slice(offset, offset + length);
  }
}

class VirtualGPURAM {
  constructor(sizeMB, autoscale = false) {
    this.sizeMB = sizeMB;
    this.autoscale = autoscale;
    this.size = sizeMB * 1024 * 1024;
    this.gpu = new GPU();
    this.bufferLength = this.size;
    this.kernel = this.gpu.createKernel(function() { return 0; })
      .setOutput([this.bufferLength]);
    this.buffer = this.kernel();
    console.log(`Virtual GPU memory initialized (${sizeMB} MB, ${this.bufferLength} elements)`);
  }

  write(offset, data) {
    for (let i = 0; i < data.length && i + offset < this.bufferLength; i++) {
      this.buffer[i + offset] = data[i];
    }
  }

  read(offset, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length && i + offset < this.bufferLength; i++) {
      out[i] = this.buffer[i];
    }
    return out;
  }
}

class VirtualCPUs {
  constructor(n, log = false) {
    this.count = n;
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(`setInterval(() => {}, 1000);`, { eval: true });
      this.workers.push(w);
    }
    console.log(`Virtual CPUs initialized (${n} workers)`);
    if (log) {
      setInterval(() => console.log("vCPU workers active:", this.workers.length), 5000);
    }
  }
}

// -------------------- Networking --------------------
function startServer(port, vram, vgpu) {
  const server = net.createServer((sock) => {
    sock.on("data", (data) => {
      if (vram) vram.write(0, data);
      if (vgpu) vgpu.write(0, data);
      console.log("Received data from client:", data.length);
    });
  });
  server.listen(port, () => console.log(`Listening for clients on port ${port}`));
}

function startClient(addr) {
  const [host, port] = addr.split(":");
  const sock = net.createConnection({ host, port: parseInt(port, 10) }, () => {
    console.log(`Connected to host ${addr}`);
    setInterval(() => sock.write(Buffer.from("heartbeat")), 5000);
  });
}

// -------------------- Main --------------------
async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  validateFlags(flags, positional);

  let vram, vgpu, vcpus;
  if (flags.ramMB) vram = new VirtualRAM(flags.ramMB, flags.autoscale);
  if (flags.gpuMB) vgpu = new VirtualGPURAM(flags.gpuMB, flags.autoscale);
  if (flags.vcpus) vcpus = new VirtualCPUs(flags.vcpus, flags.log);

  if (flags.listen) startServer(flags.listen, vram, vgpu);
  if (flags.connect) {
    startClient(flags.connect);
    return;
  }

  // Spawn child process with inherited stdio
  const app = positional[0];
  const args = positional.slice(1);
  const child = spawn(app, args, { stdio: "inherit" });
  child.on("exit", code => { console.log(`Child exited with code ${code}`); process.exit(code); });
}

main().catch(err => {
  console.error("Fatal error:", err && err.stack ? err.stack : err);
  process.exit(1);
});

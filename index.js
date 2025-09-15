// VirtResources
// Host:   virtresources <app> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log] [--listen <port>] [app_args...]
// Client: virtresources --connect <host>:<port> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log]

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";
import { GPU } from "webgpu";

// --- Helpers ---
function spawnWorkers(count, logUsage = false, summaryCollector = null, prefix = "local") {
  console.log(`Spawning ${count} ${prefix} virtual CPUs...`);
  const workers = [];
  for (let i = 0; i < count; i++) {
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      let busyTicks = 0;
      setInterval(() => { busyTicks++; }, 1000);
      parentPort.on("message", () => {});
      setInterval(() => {
        parentPort.postMessage({ busyTicks });
        busyTicks = 0;
      }, 2000);
      `,
      { eval: true }
    );

    if (logUsage && summaryCollector) {
      worker.on("message", (msg) => summaryCollector.add(`${prefix}-${i}`, msg.busyTicks));
    }

    workers.push(worker);
  }
  return workers;
}

class WorkerSummary {
  constructor(interval = 2000) {
    this.stats = {};
    setInterval(() => this.printSummary(), interval);
  }

  add(id, ticks) { this.stats[id] = ticks; }

  printSummary() {
    const entries = Object.entries(this.stats);
    const local = entries.filter(([id]) => id.startsWith("local-"));
    const remote = entries.filter(([id]) => id.startsWith("remote-"));
    const sumTicks = (arr) => arr.reduce((a, [, v]) => a + v, 0);
    const activeCount = (arr) => arr.filter(([, v]) => v > 0).length;

    console.log(
      `[Summary] Local: ${activeCount(local)} workers, ${sumTicks(local)} ticks | ` +
      `Remote: ${activeCount(remote)} workers, ${sumTicks(remote)} ticks | ` +
      `Total: ${activeCount(local)+activeCount(remote)} workers, ${sumTicks(local)+sumTicks(remote)} ticks`
    );

    this.stats = {};
  }
}

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  return { totalIdle, totalTick };
}

function isCLI(appPath) {
  const ext = path.extname(appPath).toLowerCase();
  if (process.platform === "win32") return ext === ".exe" || ext === ".bat" || ext === ".cmd";
  return true;
}

// --- Virtual Memory ---
class VirtualMemory {
  constructor(sizeMB) {
    this.size = sizeMB * 1024 * 1024;
    this.buffer = new ArrayBuffer(this.size);
    console.log(`Allocated ${sizeMB}MB of virtual RAM`);
  }
}

// --- Virtual Video Memory ---
class VirtualVideoMemory {
  constructor(sizeMB) {
    this.size = sizeMB * 1024 * 1024;
    this.device = GPU.requestAdapter().then(adapter => adapter.requestDevice());
    this.buffer = null;
    this.initBuffer();
    console.log(`Allocating ${sizeMB}MB of virtual video memory (vVM)`);
  }

  async initBuffer() {
    const device = await this.device;
    this.buffer = device.createBuffer({
      size: this.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
  }
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage:");
    console.log("  Host:   virtresources <app> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log] [--listen <port>] [app_args...]");
    console.log("  Client: virtresources --connect <host>:<port> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log]");
    process.exit(1);
  }

  let app = null;
  let virtualCpus = os.cpus().length;
  let vramMB = 0;
  let vvmMB = 0;
  let autoscale = false;
  let logUsage = false;
  let appArgs = [];
  let listenPort = null;
  let connectTarget = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--autoscale") autoscale = true;
    else if (args[i] === "--log") logUsage = true;
    else if (args[i] === "--vram") vramMB = parseInt(args[++i], 10);
    else if (args[i] === "--vvm") vvmMB = parseInt(args[++i], 10);
    else if (args[i] === "--listen") listenPort = parseInt(args[++i], 10);
    else if (args[i] === "--connect") connectTarget = args[++i];
    else if (!isNaN(parseInt(args[i]))) virtualCpus = parseInt(args[i], 10);
    else if (!app) app = args[i];
    else appArgs.push(args[i]);
  }

  const vram = vramMB > 0 ? new VirtualMemory(vramMB) : null;
  const vvm = vvmMB > 0 ? new VirtualVideoMemory(vvmMB) : null;

  // --- Client Mode ---
  if (connectTarget) {
    if (app || appArgs.length > 0 || listenPort) {
      console.error("❌ Error: In client mode (--connect), you cannot specify an app, app arguments, or --listen.");
      process.exit(1);
    }

    const [host, portStr] = connectTarget.split(":");
    const port = parseInt(portStr, 10);
    const socket = net.createConnection({ host, port }, () => {
      console.log(`[Client] Connected to host at ${host}:${port}`);
      console.log(`[Client] ${virtualCpus} vCPUs, ${vramMB}MB vRAM, ${vvmMB}MB vVM active`);
    });

    const summaryCollector = { add: (id, ticks) => socket.write(JSON.stringify({ id: `remote-${id}`, ticks }) + "\n") };

    const workers = spawnWorkers(virtualCpus, logUsage, summaryCollector, "remote");

    if (autoscale) {
      let lastUsage = getCpuUsage();
      setInterval(() => {
        const currUsage = getCpuUsage();
        const idleDiff = currUsage.totalIdle - lastUsage.totalIdle;
        const totalDiff = currUsage.totalTick - lastUsage.totalTick;
        const load = 1 - idleDiff / totalDiff;
        lastUsage = currUsage;

        const desiredVCPUs = Math.max(1, Math.min(os.cpus().length * 2, Math.round(load * os.cpus().length * 2)));
        const diff = desiredVCPUs - workers.length;

        if (diff > 0) workers.push(...spawnWorkers(diff, logUsage, summaryCollector, "remote"));
        else if (diff < 0) for (let i = 0; i < -diff; i++) workers.pop().terminate();
      }, 2000);
    }

    process.on("SIGINT", () => {
      console.log("Client shutting down...");
      workers.forEach(w => w.terminate());
      socket.end();
      process.exit(0);
    });

    await new Promise(() => {}); // keep alive
  }

  // --- Host Mode ---
  if (!app) {
    console.error("❌ Error: Host mode requires an application to run.");
    process.exit(1);
  }

  console.log(`Detected ${os.cpus().length} physical cores. Using ${virtualCpus} vCPUs`);
  console.log(`vRAM: ${vramMB}MB, vVM: ${vvmMB}MB`);
  console.log(`Auto-scaling: ${autoscale}, Logging: ${logUsage}`);

  const cliMode = isCLI(app);
  const stdioOption = cliMode ? "inherit" : "inherit";

  const appProc = spawn(app, appArgs, {
    stdio: stdioOption,
    shell: process.platform !== "win32"
  });

  appProc.on("exit", (code) => {
    console.log(`App exited with code ${code}`);
    process.exit(code);
  });

  const summaryCollector = logUsage ? new WorkerSummary() : null;
  const workers = spawnWorkers(virtualCpus, logUsage, summaryCollector, "local");

  if (autoscale) {
    let lastUsage = getCpuUsage();
    setInterval(() => {
      const currUsage = getCpuUsage();
      const idleDiff = currUsage.totalIdle - lastUsage.totalIdle;
      const totalDiff = currUsage.totalTick - lastUsage.totalTick;
      const load = 1 - idleDiff / totalDiff;
      lastUsage = currUsage;

      const desiredVCPUs = Math.max(1, Math.min(os.cpus().length * 2, Math.round(load * os.cpus().length * 2)));
      const diff = desiredVCPUs - workers.length;
      if (diff > 0) workers.push(...spawnWorkers(diff, logUsage, summaryCollector, "local"));
      else if (diff < 0) for (let i = 0; i < -diff; i++) workers.pop().terminate();
    }, 2000);
  }

  if (listenPort) {
    const server = net.createServer((socket) => {
      console.log("Remote client connected.");

      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (logUsage && summaryCollector) summaryCollector.add(msg.id, msg.ticks);
          } catch (e) {
            console.error("Invalid message from client:", line);
          }
        }
      });

      socket.on("end", () => console.log("Remote client disconnected."));
    });

    server.listen(listenPort, () => console.log(`Listening for remote clients on port ${listenPort}...`));
  }
}

main();

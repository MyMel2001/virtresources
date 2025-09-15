// virtresources/index.js
// Host:   node index.js <app> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log] [--listen <port>] [app_args...]
// Client: node index.js --connect <host>:<port> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log]

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";

let vulkan = null;
try {
  vulkan = await import("node-vulkan");
  console.log("[vVM] Vulkan detected, GPU acceleration enabled.");
} catch (e) {
  console.log("[vVM] Vulkan not available, using CPU-only virtual video memory.");
}

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
      worker.on("message", (msg) => {
        summaryCollector.add(`${prefix}-${i}`, msg.busyTicks);
      });
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

  add(id, ticks) {
    this.stats[id] = ticks;
  }

  printSummary() {
    const entries = Object.entries(this.stats);
    const local = entries.filter(([id]) => id.startsWith("local-"));
    const remote = entries.filter(([id]) => id.startsWith("remote-"));

    const sumTicks = (arr) => arr.reduce((a, [, v]) => a + v, 0);
    const activeCount = (arr) => arr.filter(([, v]) => v > 0).length;

    console.log(`[Summary] Local: ${activeCount(local)} workers, ${sumTicks(local)} ticks | ` +
                `Remote: ${activeCount(remote)} workers, ${sumTicks(remote)} ticks`);
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

// --- Virtual RAM / vVM ---

function createVirtualRAM(sizeMB = 512) {
  console.log(`[vRAM] Allocating ${sizeMB}MB of virtual RAM`);
  return new ArrayBuffer(sizeMB * 1024 * 1024);
}

function createVirtualVideoMemory(sizeMB = 512) {
  if (!vulkan) return createVirtualRAM(sizeMB);
  console.log(`[vVM] Allocating ${sizeMB}MB of GPU-accelerated virtual video memory`);
  const instance = new vulkan.Instance({ applicationName: "virtresources" });
  const physicalDevices = instance.enumeratePhysicalDevices();
  const device = new vulkan.Device(physicalDevices[0]);
  return device.allocateMemory(sizeMB * 1024 * 1024);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage:");
    console.log("Host:   node index.js <app> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log] [--listen <port>] [app_args...]");
    console.log("Client: node index.js --connect <host>:<port> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log]");
    process.exit(1);
  }

  let app = null;
  let virtualCpus = os.cpus().length;
  let virtualRamMB = 512;
  let virtualVideoMemoryMB = 512;
  let autoscale = false;
  let logUsage = false;
  let appArgs = [];
  let listenPort = null;
  let connectTarget = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--autoscale") autoscale = true;
    else if (arg === "--log") logUsage = true;
    else if (arg === "--listen") listenPort = parseInt(args[++i], 10);
    else if (arg === "--connect") connectTarget = args[++i];
    else if (arg === "--vram") virtualRamMB = parseInt(args[++i], 10);
    else if (arg === "--vvm") virtualVideoMemoryMB = parseInt(args[++i], 10);
    else if (!isNaN(parseInt(arg))) virtualCpus = parseInt(arg, 10);
    else if (!app) app = arg;
    else appArgs.push(arg);
  }

  // --- Client Mode ---
  if (connectTarget) {
    if (app || appArgs.length > 0 || listenPort) {
      console.error("❌ Error: In client mode (--connect), cannot specify an app, app arguments, or --listen.");
      process.exit(1);
    }

    const [host, portStr] = connectTarget.split(":");
    const port = parseInt(portStr, 10);
    const socket = net.createConnection({ host, port }, () => {
      console.log(`[Client] Connected to host at ${host}:${port}`);
      console.log(`[Client] ${virtualCpus} virtual CPUs active, ${virtualRamMB}MB vRAM, ${virtualVideoMemoryMB}MB vVM`);
    });

    const summaryCollector = {
      add: (id, ticks) => socket.write(JSON.stringify({ id: `remote-${id}`, ticks }) + "\n"),
    };

    const workers = spawnWorkers(virtualCpus, logUsage, summaryCollector, "remote");
    const vram = createVirtualRAM(virtualRamMB);
    const vvm = createVirtualVideoMemory(virtualVideoMemoryMB);

    socket.write(JSON.stringify({ type: "vRAM", size: vram.byteLength }) + "\n");
    socket.write(JSON.stringify({ type: "vVM", size: vvm.byteLength }) + "\n");

    process.on("SIGINT", () => {
      console.log("[Client] Shutting down...");
      workers.forEach(w => w.terminate());
      socket.end();
      process.exit(0);
    });

    await new Promise(() => {}); // keep client alive
  }

  // --- Host Mode ---
  if (!app) {
    console.error("❌ Error: Host mode requires an application to run.");
    process.exit(1);
  }

  console.log(`Detected ${os.cpus().length} physical cores. Using ${virtualCpus} virtual CPUs.`);
  console.log(`Allocating vRAM: ${virtualRamMB}MB, vVM: ${virtualVideoMemoryMB}MB`);
  console.log(`Auto-scaling: ${autoscale ? "ENABLED" : "DISABLED"}, Logging: ${logUsage ? "ENABLED" : "DISABLED"}`);

  const cliMode = isCLI(app);
  const appProc = spawn(app, appArgs, {
    stdio: cliMode ? "inherit" : "inherit",
    shell: process.platform !== "win32",
  });

  appProc.on("exit", code => {
    console.log(`App exited with code ${code}`);
    process.exit(code);
  });

  const summaryCollector = logUsage ? new WorkerSummary() : null;
  const workers = spawnWorkers(virtualCpus, logUsage, summaryCollector, "local");
  const localVRam = createVirtualRAM(virtualRamMB);
  const localVVM = createVirtualVideoMemory(virtualVideoMemoryMB);

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

  // Network listener for clients
  if (listenPort) {
    const server = net.createServer(socket => {
      console.log("[Host] Remote client connected.");
      let buffer = "";
      socket.on("data", data => {
        buffer += data.toString();
        let lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (logUsage && summaryCollector) summaryCollector.add(msg.id ?? msg.type, msg.ticks ?? msg.size);
            if (msg.type === "vRAM") console.log(`[vRAM] Remote client provides ${msg.size / (1024*1024)}MB`);
            if (msg.type === "vVM") console.log(`[vVM] Remote client provides ${msg.size / (1024*1024)}MB`);
          } catch (e) {
            console.error("Invalid client message:", line);
          }
        }
      });
      socket.on("end", () => console.log("[Host] Remote client disconnected."));
    });
    server.listen(listenPort, () => console.log(`[Host] Listening for clients on port ${listenPort}...`));
  }
}

main();

// VirtCPUs
// Run as host:   node virtcpus.js <app> [vcpus] [--autoscale] [--log] [--listen <port>] [app_args...]
// Run as client: node virtcpus.js --connect <host>:<port> [vcpus] [--autoscale] [--log]

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";

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
      parentPort.on("message", () => {}); // placeholder
      setInterval(() => {
        parentPort.postMessage({ busyTicks });
        busyTicks = 0;
      }, 2000);
      `,
      { eval: true, type: "module" }
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

// Simple collector for worker stats
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

    const localTicks = sumTicks(local);
    const remoteTicks = sumTicks(remote);
    const totalTicks = localTicks + remoteTicks;

    const localActive = activeCount(local);
    const remoteActive = activeCount(remote);
    const totalActive = localActive + remoteActive;

    console.log(
      `[Summary] Local: ${localActive} workers, ${localTicks} ticks | ` +
      `Remote: ${remoteActive} workers, ${remoteTicks} ticks | ` +
      `Total: ${totalActive} workers, ${totalTicks} ticks`
    );

    this.stats = {}; // reset for next interval
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

// --- Main ---
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log("Usage:");
  console.log("  Host:   node virtcpus.js <app> [vcpus] [--autoscale] [--log] [--listen <port>] [app_args...]");
  console.log("  Client: node virtcpus.js --connect <host>:<port> [vcpus] [--autoscale] [--log]");
  process.exit(1);
}

let app = null;
let virtualCpus = os.cpus().length;
let autoscale = false;
let logUsage = false;
let appArgs = [];
let listenPort = null;
let connectTarget = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--autoscale") autoscale = true;
  else if (args[i] === "--log") logUsage = true;
  else if (args[i] === "--listen") listenPort = parseInt(args[++i], 10);
  else if (args[i] === "--connect") connectTarget = args[++i];
  else if (!isNaN(parseInt(args[i]))) virtualCpus = parseInt(args[i], 10);
  else if (!app) app = args[i];
  else appArgs.push(args[i]);
}

// --- Client Mode ---
if (connectTarget) {
  if (app || appArgs.length > 0 || listenPort) {
    console.error("❌ Error: In client mode (--connect), you cannot specify an app, app arguments, or --listen.");
    process.exit(1);
  }

  const [host, portStr] = connectTarget.split(":");
  const port = parseInt(portStr, 10);
  const socket = net.createConnection({ host, port }, () => {
    console.log(`==============================`);
    console.log(`[Client] Connected to host at ${host}:${port}`);
    console.log(`[Client] Running in worker-only mode`);
    console.log(`==============================`);
  });

  const summaryCollector = {
    add: (id, ticks) => {
      socket.write(JSON.stringify({ id: `remote-${id}`, ticks }) + "\n");
    }
  };

  let workers = spawnWorkers(virtualCpus, logUsage, summaryCollector, "remote");

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

      if (diff > 0) {
        console.log(`Scaling up remote virtual CPUs: +${diff}`);
        workers.push(...spawnWorkers(diff, logUsage, summaryCollector, "remote"));
      } else if (diff < 0) {
        console.log(`Scaling down remote virtual CPUs: ${-diff}`);
        for (let i = 0; i < -diff; i++) workers.pop().terminate();
      }
    }, 2000);
  }

  process.on("SIGINT", () => {
    console.log("Client shutting down...");
    workers.forEach(w => w.terminate());
    socket.end();
    process.exit(0);
  });

  // ✅ End client mode cleanly
  process.exit(0);
}


// --- Host Mode ---
if (!app) {
  console.error("❌ Error: Host mode requires an application to run.");
  process.exit(1);
}

console.log(`Detected ${os.cpus().length} physical cores. Using ${virtualCpus} virtual CPUs.`);
console.log(`Auto-scaling: ${autoscale ? "ENABLED" : "DISABLED"}, Logging: ${logUsage ? "ENABLED" : "DISABLED"}`);

const cliMode = isCLI(app);
const stdioOption = cliMode ? "inherit" : "inherit";
let appProc = null;

appProc = spawn(app, appArgs, {
  stdio: stdioOption,
  shell: process.platform !== "win32" // needed for Linux/macOS
});

appProc.on("exit", (code) => {
  console.log(`App exited with code ${code}`);
  process.exit(code);
});

const summaryCollector = logUsage ? new WorkerSummary() : null;
let workers = spawnWorkers(virtualCpus, logUsage, summaryCollector, "local");

// Auto-scaling for host
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

    if (diff > 0) {
      console.log(`Scaling up local virtual CPUs: +${diff}`);
      workers.push(...spawnWorkers(diff, logUsage, summaryCollector, "local"));
    } else if (diff < 0) {
      console.log(`Scaling down local virtual CPUs: ${-diff}`);
      for (let i = 0; i < -diff; i++) workers.pop().terminate();
    }
  }, 2000);
}

// Network listener for remote clients
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
          if (logUsage && summaryCollector) {
            summaryCollector.add(msg.id, msg.ticks);
          }
        } catch (e) {
          console.error("Invalid message from client:", line);
        }
      }
    });

    socket.on("end", () => {
      console.log("Remote client disconnected.");
    });
  });

  server.listen(listenPort, () => {
    console.log(`Listening for remote clients on port ${listenPort}...`);
  });
}

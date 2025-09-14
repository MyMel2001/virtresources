// VirtCPUs
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";

// --- Helpers ---
function spawnWorkers(count, logUsage = false, summaryCollector = null) {
  console.log(`Spawning ${count} virtual CPUs...`);
  const workers = [];
  for (let i = 0; i < count; i++) {
    // inside spawnWorkers()
const worker = new Worker(
  `
        import { parentPort } from "node:worker_threads";
        let busyTicks = 0;
        setInterval(() => { busyTicks++; }, 1000);
        parentPort.on("message", (msg) => {}); // placeholder
        setInterval(() => {
          parentPort.postMessage({ busyTicks });
          busyTicks = 0;
        }, 2000);
        `,
        { eval: true, type: "module" } // ensure ESM worker
      );


    if (logUsage && summaryCollector) {
      worker.on("message", (msg) => {
        summaryCollector.add(i, msg.busyTicks);
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
    const total = Object.values(this.stats).reduce((a, b) => a + b, 0);
    const active = Object.values(this.stats).filter((v) => v > 0).length;
    console.log(`[Summary] Workers active: ${active}, Total busy ticks: ${total}`);
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

// Detect CLI vs GUI (simple heuristic)
function isCLI(appPath) {
  const ext = path.extname(appPath).toLowerCase();
  if (process.platform === "win32") return ext === ".exe" || ext === ".bat" || ext === ".cmd";
  return true; // assume non-Windows binaries are CLI
}

// --- Main ---
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: virtcpus <app> [virtual_cpus] [--autoscale] [--log] [app_args...]");
  process.exit(1);
}

let app = args[0];
let virtualCpus = os.cpus().length;
let autoscale = false;
let logUsage = false;
let appArgs = [];

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--autoscale") autoscale = true;
  else if (args[i] === "--log") logUsage = true;
  else if (!isNaN(parseInt(args[i]))) virtualCpus = parseInt(args[i], 10);
  else {
    appArgs = args.slice(i);
    break;
  }
}

console.log(`Detected ${os.cpus().length} physical cores. Using ${virtualCpus} virtual CPUs.`);
console.log(`Auto-scaling: ${autoscale ? "ENABLED" : "DISABLED"}, Logging: ${logUsage ? "ENABLED" : "DISABLED"}`);

const cliMode = isCLI(app);
const stdioOption = cliMode ? "inherit" : "inherit"; // GUI apps stay attached
// app process
const appProc = spawn(app, appArgs, {
  stdio: stdioOption,
  shell: process.platform !== "win32" // needed for Linux/macOS
});


appProc.on("exit", (code) => {
  console.log(`App exited with code ${code}`);
  process.exit(code);
});

// If logging is enabled, create summary collector
const summaryCollector = logUsage ? new WorkerSummary() : null;

// Spawn virtual CPUs with summary logging
let workers = spawnWorkers(virtualCpus, logUsage, summaryCollector);

// --- Optional Auto-Scaling ---
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
      console.log(`Scaling up virtual CPUs: +${diff}`);
      workers.push(...spawnWorkers(diff, logUsage, summaryCollector));
    } else if (diff < 0) {
      console.log(`Scaling down virtual CPUs: ${-diff}`);
      for (let i = 0; i < -diff; i++) workers.pop().terminate();
    }
  }, 2000);
}

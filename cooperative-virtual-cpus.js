// dynamic-cooperative-wrapper.js
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import readline from "node:readline";
import os from "node:os";
import { performance } from "node:perf_hooks";

// --- Helper Functions ---
function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }

  return { totalIdle, totalTick };
}

function spawnApp(app, args = []) {
  console.log(`Launching app: ${app} ${args.join(" ")}`);
  const proc = spawn(app, args, { stdio: ["pipe", "pipe", "inherit"] });
  proc.on("exit", (code) => console.log(`App exited with code ${code}`));
  return proc;
}

function spawnWorkers(count, appProc) {
  console.log(`Spawning ${count} virtual CPUs...`);
  const workers = [];
  let rr = 0;

  for (let i = 0; i < count; i++) {
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", (chunk) => {
        // Simulate CPU-bound processing
        const result = chunk.toUpperCase();
        parentPort.postMessage(result);
      });
      `,
      { eval: true }
    );

    worker.on("message", (msg) => {
      appProc.stdin.write(msg + "\\n");
    });

    workers.push(worker);
  }

  // Read app output, chunk it efficiently
  const rl = readline.createInterface({ input: appProc.stdout });
  const chunkSize = 1; // lines per task, can adjust
  let buffer = [];

  rl.on("line", (line) => {
    buffer.push(line);
    if (buffer.length >= chunkSize) {
      const task = buffer.join("\n");
      workers[rr].postMessage(task);
      rr = (rr + 1) % workers.length;
      buffer = [];
    }
  });

  rl.on("close", () => {
    if (buffer.length > 0) {
      const task = buffer.join("\n");
      workers[rr].postMessage(task);
    }
  });

  return workers;
}

// --- Main ---
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log("Usage: node dynamic-cooperative-wrapper.js <app> [virtual_cpus] [app_args...]");
  process.exit(1);
}

const app = args[0];
const physicalCores = os.cpus().length;
let virtualCpus = args[1] ? parseInt(args[1], 10) : physicalCores;
const appArgs = args[1] ? args.slice(2) : args.slice(1);

console.log(`Detected ${physicalCores} physical cores. Using ${virtualCpus} virtual CPUs.`);

// Run app
const appProc = spawnApp(app, appArgs);

// Spawn initial workers
const workers = spawnWorkers(virtualCpus, appProc);

// --- Dynamic scaling ---
let lastUsage = getCpuUsage();
setInterval(() => {
  const currUsage = getCpuUsage();
  const idleDiff = currUsage.totalIdle - lastUsage.totalIdle;
  const totalDiff = currUsage.totalTick - lastUsage.totalTick;
  const load = 1 - idleDiff / totalDiff;

  console.log(`System CPU load: ${(load * 100).toFixed(1)}%`);

  lastUsage = currUsage;
  // Optional: dynamically increase/decrease virtual CPUs based on load
}, 2000);

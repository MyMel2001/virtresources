// universal-cooperative-wrapper.js
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import fs from "fs";
import path from "path";

// --- Helpers ---
function spawnWorkers(count) {
  console.log(`Spawning ${count} virtual CPUs...`);
  const workers = [];
  for (let i = 0; i < count; i++) {
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      // Idle worker to simulate a virtual CPU
      setInterval(() => {}, 1000);
      `,
      { eval: true }
    );
    workers.push(worker);
  }
  return workers;
}

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
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
  console.log("Usage: node universal-cooperative-wrapper.js <app> [virtual_cpus] [--autoscale] [app_args...]");
  process.exit(1);
}

let app = args[0];
let virtualCpus = os.cpus().length;
let autoscale = false;
let appArgs = [];

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--autoscale") autoscale = true;
  else if (!isNaN(parseInt(args[i]))) virtualCpus = parseInt(args[i], 10);
  else {
    appArgs = args.slice(i);
    break;
  }
}

console.log(`Detected ${os.cpus().length} physical cores. Using ${virtualCpus} virtual CPUs.`);
console.log(`Auto-scaling is ${autoscale ? "ENABLED" : "DISABLED"}.`);

// Determine stdio based on CLI/GUI
const cliMode = isCLI(app);
const stdioOption = cliMode ? "inherit" : "inherit"; // GUI apps stay attached
const appProc = spawn(app, appArgs, { stdio: stdioOption });

appProc.on("exit", (code) => {
  console.log(`App exited with code ${code}`);
  process.exit(code);
});

// Spawn virtual CPUs
let workers = spawnWorkers(virtualCpus);

// --- Optional Auto-Scaling ---
if (autoscale) {
  let lastUsage = getCpuUsage();
  setInterval(() => {
    const currUsage = getCpuUsage();
    const idleDiff = currUsage.totalIdle - lastUsage.totalIdle;
    const totalDiff = currUsage.totalTick - lastUsage.totalTick;
    const load = 1 - idleDiff / totalDiff;
    lastUsage = currUsage;

    // Adjust virtual CPUs based on load
    const desiredVCPUs = Math.max(1, Math.min(os.cpus().length * 2, Math.round(load * os.cpus().length * 2)));
    const diff = desiredVCPUs - workers.length;

    if (diff > 0) {
      console.log(`Scaling up virtual CPUs: +${diff}`);
      workers.push(...spawnWorkers(diff));
    } else if (diff < 0) {
      console.log(`Scaling down virtual CPUs: ${-diff}`);
      for (let i = 0; i < -diff; i++) workers.pop().terminate();
    }
  }, 2000);
}

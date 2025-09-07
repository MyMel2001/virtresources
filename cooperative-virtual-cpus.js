// cooperative-virtual-cpus.js
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import readline from "node:readline";

function spawnApp(app, args = []) {
  console.log(`Launching app: ${app} ${args.join(" ")}`);
  const proc = spawn(app, args, { stdio: ["pipe", "pipe", "inherit"] });
  return proc;
}

function spawnWorkers(count, appProc) {
  const workers = [];
  let rr = 0;

  for (let i = 0; i < count; i++) {
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", (msg) => {
        // Simulate CPU-heavy task: e.g. uppercase transformation
        let result = msg.toUpperCase();
        parentPort.postMessage(result);
      });
      `,
      { eval: true }
    );

    worker.on("message", (data) => {
      // Feed results back into the app’s stdin
      appProc.stdin.write(data + "\\n");
    });

    workers.push(worker);
  }

  // Read app output, distribute work to workers
  const rl = readline.createInterface({ input: appProc.stdout });
  rl.on("line", (line) => {
    workers[rr].postMessage(line);
    rr = (rr + 1) % workers.length;
  });

  return workers;
}

// --- Main ---
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log("Usage: node cooperative-virtual-cpus.js <app> <virtual_cpus> [app_args...]");
  process.exit(1);
}

const app = args[0];
const vcpus = parseInt(args[1], 10);
const appArgs = args.slice(2);

const appProc = spawnApp(app, appArgs);
spawnWorkers(vcpus, appProc);

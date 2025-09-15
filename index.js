// virtresources.js
// Host:   node virtresources.js <app> [vcpus] [--vram <mb>] [--vvm <mb>] [--autoscale] [--log] [--listen <port>] [app_args...]
// Client: node virtresources.js --connect <host>:<port> [vcpus] [--vram <mb>] [--vvm <mb>] [--autoscale] [--log]

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";

// --- Helpers ---
function spawnWorkers(count, logUsage = false, summaryCollector = null, prefix = "local", type = "vCPU") {
  console.log(`Spawning ${count} ${prefix} ${type} workers...`);
  const workers = [];
  for (let i = 0; i < count; i++) {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      let busyTicks = 0;
      setInterval(() => { busyTicks++; }, 1000);
      parentPort.on("message", () => {});
      setInterval(() => {
        parentPort.postMessage({ busyTicks });
        busyTicks = 0;
      }, 2000);
    `, { eval: true });

    if (logUsage && summaryCollector) {
      worker.on("message", (msg) => {
        summaryCollector.add(`${prefix}-${type}-${i}`, msg.busyTicks);
      });
    }
    workers.push(worker);
  }
  return workers;
}

class ResourceSummary {
  constructor(interval = 2000) {
    this.stats = {};
    setInterval(() => this.printSummary(), interval);
  }

  add(id, ticks) { this.stats[id] = ticks; }

  printSummary() {
    const entries = Object.entries(this.stats);
    const summaryByType = { vCPU: [], vRAM: [], vVM: [] };

    for (const [id, ticks] of entries) {
      if (id.includes("vCPU")) summaryByType.vCPU.push([id, ticks]);
      else if (id.includes("vRAM")) summaryByType.vRAM.push([id, ticks]);
      else if (id.includes("vVM")) summaryByType.vVM.push([id, ticks]);
    }

    const sumTicks = arr => arr.reduce((a, [,v]) => a+v,0);
    const activeCount = arr => arr.filter(([,v])=>v>0).length;

    const printLine = (label, arr) => `${label}: ${activeCount(arr)} workers, ${sumTicks(arr)} ticks`;

    console.log(`[Summary] ${printLine('vCPU', summaryByType.vCPU)} | ${printLine('vRAM', summaryByType.vRAM)} | ${printLine('vVM', summaryByType.vVM)}`);

    this.stats = {};
  }
}

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const t in cpu.times) totalTick += cpu.times[t];
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
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage:");
    console.log("  Host:   node virtresources.js <app> [vcpus] [--vram <mb>] [--vvm <mb>] [--autoscale] [--log] [--listen <port>] [app_args...]");
    console.log("  Client: node virtresources.js --connect <host>:<port> [vcpus] [--vram <mb>] [--vvm <mb>] [--autoscale] [--log]");
    process.exit(1);
  }

  let app = null;
  let virtualCpus = os.cpus().length;
  let virtualRam = 0;
  let virtualVM = 0;
  let autoscale = false;
  let logUsage = false;
  let appArgs = [];
  let listenPort = null;
  let connectTarget = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--autoscale") autoscale = true;
    else if (arg === "--log") logUsage = true;
    else if (arg === "--listen") listenPort = parseInt(args[++i],10);
    else if (arg === "--connect") connectTarget = args[++i];
    else if (arg === "--vram") virtualRam = parseInt(args[++i],10);
    else if (arg === "--vvm") virtualVM = parseInt(args[++i],10);
    else if (!isNaN(parseInt(arg))) virtualCpus = parseInt(arg,10);
    else if (!app) app = arg;
    else appArgs.push(arg);
  }

  // --- Client Mode ---
  if (connectTarget) {
    if (app || appArgs.length > 0 || listenPort) {
      console.error("❌ Error: Client mode cannot specify app, app_args, or --listen");
      process.exit(1);
    }

    const [host, portStr] = connectTarget.split(":");
    const port = parseInt(portStr,10);
    const socket = net.createConnection({ host, port }, () => {
      console.log(`Connected to host ${host}:${port}`);
      console.log(`Client mode: vCPUs=${virtualCpus}, vRAM=${virtualRam}MB, vVM=${virtualVM}MB`);
    });

    const summaryCollector = {
      add: (id, ticks) => socket.write(JSON.stringify({id:`remote-${id}`, ticks}) + "\n")
    };

    const workersCPU = spawnWorkers(virtualCpus, logUsage, summaryCollector, "remote", "vCPU");
    const workersRAM = spawnWorkers(virtualRam, logUsage, summaryCollector, "remote", "vRAM");
    const workersVM  = spawnWorkers(virtualVM, logUsage, summaryCollector, "remote", "vVM");

    // autoscale
    if(autoscale){
      let lastUsage = getCpuUsage();
      setInterval(()=>{
        const curr = getCpuUsage();
        const load = 1-(curr.totalIdle-lastUsage.totalIdle)/(curr.totalTick-lastUsage.totalTick);
        lastUsage=curr;
        const desired=Math.max(1, Math.min(os.cpus().length*2, Math.round(load*os.cpus().length*2)));
        const diff = desired - workersCPU.length;
        if(diff>0) workersCPU.push(...spawnWorkers(diff, logUsage, summaryCollector, "remote", "vCPU"));
        else if(diff<0) for(let i=0;i<-diff;i++) workersCPU.pop().terminate();
      },2000);
    }

    process.on("SIGINT",()=>{
      console.log("Client shutting down...");
      [...workersCPU, ...workersRAM, ...workersVM].forEach(w=>w.terminate());
      socket.end();
      process.exit(0);
    });

    await new Promise(()=>{}); // keep alive
  }

  // --- Host Mode ---
  if (!app) {
    console.error("❌ Error: Host mode requires an application to run.");
    process.exit(1);
  }

  console.log(`Physical cores: ${os.cpus().length}. Using vCPUs=${virtualCpus}, vRAM=${virtualRam}MB, vVM=${virtualVM}MB`);
  console.log(`Auto-scaling=${autoscale}, Logging=${logUsage}`);

  const cliMode = isCLI(app);
  const stdioOption = cliMode ? "inherit":"inherit";

  const appProc = spawn(app, appArgs, { stdio: stdioOption, shell: process.platform!=="win32" });
  appProc.on("exit", code=>{ console.log(`App exited with code ${code}`); process.exit(code); });

  const summaryCollector = logUsage ? new ResourceSummary() : null;

  const workersCPU = spawnWorkers(virtualCpus, logUsage, summaryCollector, "local", "vCPU");
  const workersRAM = spawnWorkers(virtualRam, logUsage, summaryCollector, "local", "vRAM");
  const workersVM  = spawnWorkers(virtualVM, logUsage, summaryCollector, "local", "vVM");

  // Host autoscale for vCPU only
  if(autoscale){
    let lastUsage = getCpuUsage();
    setInterval(()=>{
      const curr = getCpuUsage();
      const load = 1-(curr.totalIdle-lastUsage.totalIdle)/(curr.totalTick-lastUsage.totalTick);
      lastUsage = curr;
      const desired = Math.max(1, Math.min(os.cpus().length*2, Math.round(load*os.cpus().length*2)));
      const diff = desired - workersCPU.length;
      if(diff>0) workersCPU.push(...spawnWorkers(diff, logUsage, summaryCollector, "local", "vCPU"));
      else if(diff<0) for(let i=0;i<-diff;i++) workersCPU.pop().terminate();
    },2000);
  }

  // Network listener for remote clients
  if(listenPort){
    const server = net.createServer(socket=>{
      console.log("Remote client connected.");
      let buffer="";
      socket.on("data", data=>{
        buffer += data.toString();
        let lines = buffer.split("\n");
        buffer = lines.pop();
        for(const line of lines){
          if(!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if(logUsage && summaryCollector) summaryCollector.add(msg.id,msg.ticks);
          } catch(e){
            console.error("Invalid message from client:", line);
          }
        }
      });
      socket.on("end",()=>console.log("Remote client disconnected."));
    });
    server.listen(listenPort, ()=>console.log(`Listening on port ${listenPort}...`));
  }
}

main();

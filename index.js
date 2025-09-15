import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";
import { create, globals } from "webgpu";
import { PNG } from "pngjs";
import fs from "fs";

Object.assign(globalThis, globals);

// --- Virtual CPU Helpers ---
function spawnWorkers(count, summaryCollector = null, prefix = "local") {
  console.log(`Spawning ${count} ${prefix} virtual CPUs...`);
  const workers = [];
  for (let i = 0; i < count; i++) {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      let busyTicks = 0;
      setInterval(() => busyTicks++, 1000);
      setInterval(() => {
        parentPort.postMessage({ busyTicks });
        busyTicks = 0;
      }, 2000);
    `, { eval: true });

    if (summaryCollector) {
      worker.on("message", msg => summaryCollector.add(`${prefix}-${i}`, msg.busyTicks));
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
    const sumTicks = arr => arr.reduce((a, [,v]) => a+v,0);
    const activeCount = arr => arr.filter(([,v])=>v>0).length;

    const local = entries.filter(([id])=>id.startsWith("local-"));
    const remote = entries.filter(([id])=>id.startsWith("remote-"));

    console.log(`[Summary] Local: ${activeCount(local)} workers, ${sumTicks(local)} ticks | ` +
                `Remote: ${activeCount(remote)} workers, ${sumTicks(remote)} ticks`);
    this.stats = {};
  }
}

// --- Virtual RAM ---
class VirtualRAM {
  constructor(sizeMB = 512) {
    this.buffer = Buffer.alloc(sizeMB * 1024 * 1024);
    console.log(`Allocated ${sizeMB} MB of virtual RAM`);
  }
}

// --- Virtual Video Memory (WebGPU) ---
async function initVirtualVideoMemory(width=256, height=256) {
  try {
    const navigator = { gpu: create([]) };
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("No GPU adapter found");

    const device = await adapter.requestDevice();
    if (!device) throw new Error("Failed to create GPU device");

    const texture = device.createTexture({
      format: "rgba8unorm",
      usage: 0x10 | 0x04, // RENDER_ATTACHMENT | COPY_SRC
      size: [width, height]
    });

    console.log(`Virtual video memory initialized: ${width}x${height}`);
    return { device, texture, width, height };
  } catch (err) {
    console.warn("WebGPU failed, fallback to CPU virtual video memory:", err.message);
    return null;
  }
}

// --- Main Function ---
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage:\n Host: virtresources <app> [vcpus] [--autoscale] [--log] [--listen <port>] [app_args...]\n Client: virtresources --connect <host>:<port> [vcpus] [--autoscale] [--log]");
    process.exit(1);
  }

  let app = null, vcpus = os.cpus().length, autoscale=false, logUsage=false;
  let appArgs=[], listenPort=null, connectTarget=null;

  for (let i=0;i<args.length;i++){
    if(args[i]=="--autoscale") autoscale=true;
    else if(args[i]=="--log") logUsage=true;
    else if(args[i]=="--listen") listenPort=parseInt(args[++i]);
    else if(args[i]=="--connect") connectTarget=args[++i];
    else if(!isNaN(parseInt(args[i]))) vcpus=parseInt(args[i]);
    else if(!app) app=args[i];
    else appArgs.push(args[i]);
  }

  const summaryCollector = logUsage ? new WorkerSummary() : null;
  const localVRAM = await initVirtualVideoMemory(256,256);
  const localRAM = new VirtualRAM(512);

  // --- Client Mode ---
  if(connectTarget){
    const [host, portStr] = connectTarget.split(":");
    const port = parseInt(portStr,10);
    const socket = net.createConnection({host,port},()=>console.log(`[Client] Connected to host ${host}:${port}`));

    const workers = spawnWorkers(vcpus, summaryCollector, "remote");

    process.on("SIGINT", ()=>{
      workers.forEach(w=>w.terminate());
      socket.end();
      process.exit(0);
    });

    await new Promise(()=>{}); // keep alive
  }

  // --- Host Mode ---
  if(!app){
    console.error("Host mode requires an application to run.");
    process.exit(1);
  }

  const cliMode = path.extname(app).toLowerCase() === ".exe" || os.platform()==="win32";
  spawn(app, appArgs, { stdio:"inherit", shell:os.platform()!=="win32" });

  const workers = spawnWorkers(vcpus, summaryCollector, "local");

  if(listenPort){
    const server = net.createServer(socket=>{
      console.log("Remote client connected.");
      let buffer="";
      socket.on("data",data=>{
        buffer+=data.toString();
        let lines=buffer.split("\n"); buffer=lines.pop();
        for(const line of lines){
          if(!line.trim()) continue;
          try{const msg=JSON.parse(line); summaryCollector?.add(msg.id,msg.ticks);}catch(e){console.error("Invalid message from client:",line);}
        }
      });
      socket.on("end",()=>console.log("Remote client disconnected."));
    });
    server.listen(listenPort,()=>console.log(`Listening for remote clients on port ${listenPort}`));
  }
}

main();

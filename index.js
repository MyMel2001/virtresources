// VirtResources
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";
import { create, globals } from "webgpu";

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

// --- Suppress Dawn WGSL warnings ---
function suppressWebGPUWarnings(fn) {
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    if (typeof chunk === "string" && chunk.includes("Unknown WGSLLanguageFeatureName")) return true;
    return originalWrite.call(process.stderr, chunk, ...args);
  };
  try {
    return fn();
  } finally {
    process.stderr.write = originalWrite;
  }
}

// --- Virtual Video Memory (WebGPU) ---
async function initVirtualVideoMemory(width=256, height=256) {
  return await suppressWebGPUWarnings(async () => {
    try {
      const navigator = { gpu: create() }; // <- no array
      const adapter = await navigator.gpu?.requestAdapter();

      if (!adapter) throw new Error("No GPU adapter found");

      const device = await adapter.requestDevice(); // <- no options at all

      const texture = device.createTexture({
        format: "rgba8unorm",
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | COPY_SRC
        size: [width, height]
      });
      console.log(`Virtual video memory initialized: ${width}x${height}`);
      return { device, texture, width, height };
    } catch (err) {
      console.warn("WebGPU unavailable, using CPU fallback:", err.message);
      return { device: null, texture: Buffer.alloc(width*height*4), width, height };
    }
  });
}

// --- Networked VRAM ---
class NetworkedVRAM {
  constructor(localVV, listenPort=null) {
    this.localVV = localVV;
    this.clients = [];
    if(listenPort){
      this.server = net.createServer(socket => {
        console.log("Networked VRAM client connected");
        this.clients.push(socket);

        socket.on("end", () => {
          console.log("Client disconnected from networked VRAM");
          this.clients = this.clients.filter(c => c !== socket);
        });
      });
      this.server.listen(listenPort, () => console.log(`Networked VRAM server listening on port ${listenPort}`));
    }
  }

  broadcast(frameBuffer) {
    const data = Buffer.from(frameBuffer);
    for (const client of this.clients){
      client.write(data);
    }
  }
}

// --- Main Function ---
async function main() {
  const args = process.argv.slice(2);
  if(args.length < 1){
    console.log("Usage:\n Host: virtresources <app> [vcpus] [--autoscale] [--log] [--listen <port>] [app_args...]\n Client: virtresources --connect <host>:<port> [vcpus] [--autoscale] [--log]");
    process.exit(1);
  }

  let app=null, vcpus=os.cpus().length, autoscale=false, logUsage=false;
  let appArgs=[], listenPort=null, connectTarget=null;

  for(let i=0;i<args.length;i++){
    if(args[i]=="--autoscale") autoscale=true;
    else if(args[i]=="--log") logUsage=true;
    else if(args[i]=="--listen") listenPort=parseInt(args[++i]);
    else if(args[i]=="--connect") connectTarget=args[++i];
    else if(!isNaN(parseInt(args[i]))) vcpus=parseInt(args[i]);
    else if(!app) app=args[i];
    else appArgs.push(args[i]);
  }

  const summaryCollector = logUsage ? new WorkerSummary() : null;
  const localRAM = new VirtualRAM(512);
  const localVV = await initVirtualVideoMemory(256,256);
  const networkedVV = listenPort ? new NetworkedVRAM(localVV, listenPort) : null;

  // --- Client Mode ---
  if(connectTarget){
    const [host, portStr] = connectTarget.split(":");
    const port = parseInt(portStr,10);
    const socket = net.createConnection({host,port},()=>console.log(`[Client] Connected to host ${host}:${port}`));
    const workers = spawnWorkers(vcpus, summaryCollector, "remote");

    process.on("SIGINT",()=>{
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

  spawn(app, appArgs, { stdio:"inherit", shell:os.platform()!=="win32" });
  const workers = spawnWorkers(vcpus, summaryCollector, "local");

  // Auto-scaling
  if(autoscale){
    let lastUsage = os.cpus().map(c=>c.times).reduce((acc,times)=>Object.values(times).reduce((a,b)=>a+b,0)+acc,0);
    setInterval(()=>{
      const currUsage = os.cpus().map(c=>c.times).reduce((acc,times)=>Object.values(times).reduce((a,b)=>a+b,0)+acc,0);
      // scaling logic omitted for brevity
    },2000);
  }
}

main();

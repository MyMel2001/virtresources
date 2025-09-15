// VirtResources
// Host:   node index.js <app> [vcpus] [--autoscale] [--log] [--listen <port>] [--vram <MB>] [--vvm <MB>] [app_args...]
// Client: node index.js --connect <host>:<port> [vcpus] [--autoscale] [--log] [--vram <MB>] [--vvm <MB>]

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";
import { create, globals } from "webgpu";
Object.assign(globalThis, globals);
const navigator = { gpu: create([]) };

// --- Helpers ---
function spawnWorkers(count, logUsage = false, summaryCollector = null, prefix = "local") {
  console.log(`Spawning ${count} ${prefix} virtual CPUs...`);
  const workers = [];
  for (let i = 0; i < count; i++) {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      let busyTicks = 0;
      setInterval(() => { busyTicks++; }, 1000);
      parentPort.on("message", () => {});
      setInterval(() => { parentPort.postMessage({ busyTicks }); busyTicks=0; }, 2000);
    `, { eval: true });
    if (logUsage && summaryCollector) {
      worker.on("message", (msg) => summaryCollector.add(`${prefix}-${i}`, msg.busyTicks));
    }
    workers.push(worker);
  }
  return workers;
}

// --- Summary Collector ---
class WorkerSummary {
  constructor(interval = 2000) {
    this.stats = {};
    setInterval(() => this.printSummary(), interval);
  }
  add(id, ticks) { this.stats[id] = ticks; }
  printSummary() {
    const entries = Object.entries(this.stats);
    const sumTicks = arr => arr.reduce((a, [,v]) => a+v, 0);
    const activeCount = arr => arr.filter(([,v]) => v>0).length;
    const local = entries.filter(([id]) => id.startsWith("local-"));
    const remote = entries.filter(([id]) => id.startsWith("remote-"));
    console.log(`[Summary] Local: ${activeCount(local)} workers, ${sumTicks(local)} ticks | Remote: ${activeCount(remote)} workers, ${sumTicks(remote)} ticks | Total: ${activeCount(local)+activeCount(remote)} workers, ${sumTicks(local)+sumTicks(remote)} ticks`);
    this.stats = {};
  }
}

// --- Virtual RAM ---
class VirtualRAM {
  constructor(sizeMB, networked=false, socket=null, clientId=null) {
    this.size = sizeMB * 1024 * 1024;
    this.networked = networked;
    this.socket = socket;
    this.clientId = clientId;
    this.buffer = Buffer.alloc(this.size);
    console.log(`Allocated ${sizeMB}MB of ${networked?"networked ":""}virtual RAM`);
  }
  startReporting(interval=2000) {
    if(this.networked && this.socket && this.clientId) {
      setInterval(() => {
        this.socket.write(JSON.stringify({ id:`remote-vram-${this.clientId}`, allocatedMB:this.size/(1024*1024)})+"\n");
      }, interval);
    }
  }
}

// --- Virtual Video Memory (vVM) ---
class VirtualVideoMemory {
  constructor(sizeMB, networked=false, socket=null, clientId=null) {
    this.size = sizeMB * 1024 * 1024;
    this.networked = networked;
    this.socket = socket;
    this.clientId = clientId;
    this.buffer = null;
    this.initDeviceAndBuffer();
  }

  async initDeviceAndBuffer() {
    const adapter = await navigator.gpu.requestAdapter();
    this.device = await adapter.requestDevice();
    this.buffer = this.device.createBuffer({
      size: this.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    console.log(`Allocated ${this.size/(1024*1024)}MB of ${this.networked?"networked ":""}virtual video memory`);
  }

  startReporting(interval=2000){
    if(!this.networked || !this.socket || !this.clientId) return;
    setInterval(() => {
      this.socket.write(JSON.stringify({ id:`remote-vvm-${this.clientId}`, allocatedMB:this.size/(1024*1024)})+"\n");
    }, interval);
  }
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  if(args.length<1){ console.log("Usage:\n Host: node index.js <app> [vcpus] [--autoscale] [--log] [--listen <port>] [--vram <MB>] [--vvm <MB>] [app_args...]\n Client: node index.js --connect <host>:<port> [vcpus] [--autoscale] [--log] [--vram <MB>] [--vvm <MB>]"); process.exit(1);}
  
  let app = null, virtualCpus=os.cpus().length, autoscale=false, logUsage=false, appArgs=[], listenPort=null, connectTarget=null;
  let vRAM_MB=0, vVM_MB=0;

  for(let i=0;i<args.length;i++){
    if(args[i]==="--autoscale") autoscale=true;
    else if(args[i]==="--log") logUsage=true;
    else if(args[i]==="--listen") listenPort=parseInt(args[++i],10);
    else if(args[i]==="--connect") connectTarget=args[++i];
    else if(args[i]==="--vram") vRAM_MB=parseInt(args[++i],10);
    else if(args[i]==="--vvm") vVM_MB=parseInt(args[++i],10);
    else if(!isNaN(parseInt(args[i]))) virtualCpus=parseInt(args[i],10);
    else if(!app) app=args[i];
    else appArgs.push(args[i]);
  }

  // --- Client Mode ---
  if(connectTarget){
    if(app||appArgs.length>0||listenPort){ console.error("❌ In client mode you cannot specify app, args, or --listen"); process.exit(1);}
    const [host, portStr] = connectTarget.split(":");
    const port=parseInt(portStr,10);
    const socket = net.createConnection({host,port}, ()=>console.log(`[Client] Connected to host ${host}:${port}, ${virtualCpus} vCPUs active.`));
    const summaryCollector = { add:(id,ticks)=>{ socket.write(JSON.stringify({id:`remote-${id}`, ticks})+"\n"); } };
    const workers = spawnWorkers(virtualCpus,logUsage,summaryCollector,"remote");
    const vRAM = vRAM_MB>0?new VirtualRAM(vRAM_MB,true,socket,"client"):null;
    if(vRAM) vRAM.startReporting();
    const vVM = vVM_MB>0?new VirtualVideoMemory(vVM_MB,true,socket,"client"):null;
    if(vVM) vVM.startReporting();
    await new Promise(()=>{}); // Keep alive
  }

  // --- Host Mode ---
  if(!app){ console.error("❌ Host mode requires an application"); process.exit(1);}
  console.log(`Detected ${os.cpus().length} physical cores. Using ${virtualCpus} vCPUs. Auto-scale: ${autoscale}, Log: ${logUsage}`);

  const cliMode = path.extname(app).toLowerCase() === ".exe" || process.platform!=="win32";
  const appProc = spawn(app, appArgs, { stdio:cliMode?"inherit":"inherit", shell:process.platform!=="win32" });

  appProc.on("exit",(code)=>{ console.log(`App exited with code ${code}`); process.exit(code); });

  const summaryCollector = logUsage?new WorkerSummary():null;
  const workers = spawnWorkers(virtualCpus,logUsage,summaryCollector,"local");

  // vRAM and vVM allocation
  const localVRAM = vRAM_MB>0?new VirtualRAM(vRAM_MB,false):null;
  const localVVM = vVM_MB>0?new VirtualVideoMemory(vVM_MB,false):null;

  // Auto-scaling for host (optional)
  if(autoscale){
    let lastUsage=getCpuUsage();
    setInterval(()=>{
      const currUsage=getCpuUsage();
      const load=1-(currUsage.totalIdle-lastUsage.totalIdle)/(currUsage.totalTick-lastUsage.totalTick);
      lastUsage=currUsage;
      const desiredVCPUs=Math.max(1,Math.min(os.cpus().length*2,Math.round(load*os.cpus().length*2)));
      const diff=desiredVCPUs-workers.length;
      if(diff>0) workers.push(...spawnWorkers(diff,logUsage,summaryCollector,"local"));
      else if(diff<0) for(let i=0;i<-diff;i++) workers.pop().terminate();
    },2000);
  }

  // Host network listener
  if(listenPort){
    const server = net.createServer(socket=>{
      console.log("Remote client connected");
      let buffer="";
      socket.on("data",(data)=>{
        buffer+=data.toString();
        let lines=buffer.split("\n"); buffer=lines.pop();
        for(const line of lines){
          if(!line.trim()) continue;
          try{
            const msg=JSON.parse(line);
            if(logUsage && summaryCollector) summaryCollector.add(msg.id,msg.ticks);
          }catch(e){console.error("Invalid client message",line);}
        }
      });
      socket.on("end",()=>console.log("Remote client disconnected"));
    });
    server.listen(listenPort,()=>console.log(`Listening for remote clients on port ${listenPort}...`));
  }
}

main();

// VirtResources
// Host:   node virtresources.js <app> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log] [--listen <port>] [app_args...]
// Client: node virtresources.js --connect <host>:<port> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log]

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "path";
import net from "net";
import WebGPU from "webgpu"; // npm install webgpu

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
      worker.on("message", (msg) => summaryCollector.add(`${prefix}-${i}`, msg.busyTicks));
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
    const local = entries.filter(([id]) => id.startsWith("local-"));
    const remote = entries.filter(([id]) => id.startsWith("remote-"));
    const sumTicks = (arr) => arr.reduce((a, [,v]) => a+v, 0);
    const activeCount = (arr) => arr.filter(([,v])=>v>0).length;

    console.log(`[Summary] Local: ${activeCount(local)} workers, ${sumTicks(local)} ticks | Remote: ${activeCount(remote)} workers, ${sumTicks(remote)} ticks | Total: ${activeCount(local)+activeCount(remote)} workers, ${sumTicks(local)+sumTicks(remote)} ticks`);
    this.stats = {};
  }
}

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle=0, totalTick=0;
  for (const cpu of cpus) for(const t in cpu.times) totalTick+=cpu.times[t], totalIdle+=cpu.times.idle;
  return { totalIdle, totalTick };
}

function isCLI(appPath) {
  const ext = path.extname(appPath).toLowerCase();
  if (process.platform === "win32") return [".exe",".bat",".cmd"].includes(ext);
  return true;
}

// --- Virtual RAM ---
class VirtualRAM {
  constructor(sizeMB, networked=false, clientId=null, socket=null) {
    this.size = sizeMB * 1024 * 1024;
    this.buffer = new ArrayBuffer(this.size);
    this.networked = networked;
    this.clientId = clientId;
    this.socket = socket;
    console.log(`Allocating ${sizeMB}MB of ${networked?"networked ":""}virtual RAM`);
  }

  startReporting(interval=2000){
    if(!this.networked||!this.socket||!this.clientId) return;
    setInterval(()=>this.socket.write(JSON.stringify({id:`remote-vram-${this.clientId}`,allocatedMB:this.size/(1024*1024)})+"\n"), interval);
  }
}

// --- Virtual Video Memory (vVM) ---
class VirtualVideoMemory {
  constructor(sizeMB, networked=false, clientId=null, socket=null) {
    this.size = sizeMB*1024*1024;
    this.networked = networked;
    this.clientId = clientId;
    this.socket = socket;
    this.device = WebGPU.requestAdapter().then(adapter=>adapter.requestDevice());
    this.buffer = null;
    this.initBuffer();
    console.log(`Allocating ${sizeMB}MB of ${networked?"networked ":""}virtual video memory`);
  }

  async initBuffer(){
    const device = await this.device;
    this.buffer = device.createBuffer({size:this.size,usage:WebGPU.GPUBufferUsage.STORAGE|WebGPU.GPUBufferUsage.COPY_SRC|WebGPU.GPUBufferUsage.COPY_DST});
  }

  startReporting(interval=2000){
    if(!this.networked||!this.socket||!this.clientId) return;
    setInterval(()=>this.socket.write(JSON.stringify({id:`remote-vvm-${this.clientId}`,allocatedMB:this.size/(1024*1024)})+"\n"), interval);
  }
}

// --- Networked pooling ---
class NetworkedPool {
  constructor(){ this.pool={}; }
  addReport(msg){ this.pool[msg.id]=msg.allocatedMB; }
  summary(type="vResource"){ const total=Object.values(this.pool).reduce((a,b)=>a+b,0); console.log(`[${type} Pool] Total pooled: ${total}MB`);}
}

// --- Main ---
async function main(){
  const args=process.argv.slice(2);
  if(args.length<1){console.log("Usage: Host: node virtresources.js <app> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log] [--listen <port>] [app_args...]"); console.log("Client: node virtresources.js --connect <host>:<port> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log]"); process.exit(1); }

  let app=null, virtualCpus=os.cpus().length, autoscale=false, logUsage=false, appArgs=[], listenPort=null, connectTarget=null, vramMB=0, vvmMB=0;
  for(let i=0;i<args.length;i++){
    if(args[i]=="--autoscale") autoscale=true;
    else if(args[i]=="--log") logUsage=true;
    else if(args[i]=="--listen") listenPort=parseInt(args[++i],10);
    else if(args[i]=="--connect") connectTarget=args[++i];
    else if(args[i]=="--vram") vramMB=parseInt(args[++i],10);
    else if(args[i]=="--vvm") vvmMB=parseInt(args[++i],10);
    else if(!isNaN(parseInt(args[i]))) virtualCpus=parseInt(args[i],10);
    else if(!app) app=args[i];
    else appArgs.push(args[i]);
  }

  // --- Client Mode ---
  if(connectTarget){
    if(app||appArgs.length>0||listenPort){ console.error("❌ Error: In client mode (--connect), cannot specify app, app args, or --listen."); process.exit(1); }
    const [host, portStr]=connectTarget.split(":"); const port=parseInt(portStr,10);
    const socket=net.createConnection({host,port},()=>console.log(`[Client] Connected to host at ${host}:${port}, vCPUs: ${virtualCpus}`));

    const summaryCollector={ add:(id,ticks)=>socket.write(JSON.stringify({id:`remote-${id}`,ticks})+"\n") };
    const workers=spawnWorkers(virtualCpus, logUsage, summaryCollector, "remote");

    const vram = vramMB>0?new VirtualRAM(vramMB,true,`client-${Math.floor(Math.random()*1000)}`,socket):null;
    if(vram) vram.startReporting();
    const vvm = vvmMB>0?new VirtualVideoMemory(vvmMB,true,`client-${Math.floor(Math.random()*1000)}`,socket):null;
    if(vvm) vvm.startReporting();

    if(autoscale){ let lastUsage=getCpuUsage(); setInterval(()=>{ const curr=getCpuUsage(); const load=1-(curr.totalIdle-lastUsage.totalIdle)/(curr.totalTick-lastUsage.totalTick); lastUsage=curr; const desired=Math.max(1,Math.min(os.cpus().length*2,Math.round(load*os.cpus().length*2))); const diff=desired-workers.length; if(diff>0) workers.push(...spawnWorkers(diff,logUsage,summaryCollector,"remote")); else if(diff<0) for(let i=0;i<-diff;i++) workers.pop().terminate(); },2000); }

    process.on("SIGINT",()=>{ console.log("Client shutting down..."); workers.forEach(w=>w.terminate()); socket.end(); process.exit(0); });
    await new Promise(()=>{}); // keep alive
  }

  // --- Host Mode ---
  if(!app){ console.error("❌ Error: Host mode requires an application to run."); process.exit(1); }
  console.log(`Detected ${os.cpus().length} physical cores. Using ${virtualCpus} virtual CPUs. vRAM: ${vramMB}MB, vVM: ${vvmMB}MB. Auto-scale: ${autoscale}, Log: ${logUsage}`);
  const cliMode=isCLI(app);
  const stdioOption=cliMode?"inherit":"inherit";

  const appProc=spawn(app,appArgs,{stdio:stdioOption,shell:process.platform!=="win32"});
  appProc.on("exit",code=>{console.log(`App exited with code ${code}`); process.exit(code); });

  const summaryCollector=logUsage?new WorkerSummary():null;
  const workers=spawnWorkers(virtualCpus,logUsage,summaryCollector,"local");

  const vram = vramMB>0?new VirtualRAM(vramMB,false,null,null):null;
  const vvm = vvmMB>0?new VirtualVideoMemory(vvmMB,false,null,null):null;

  if(autoscale){ let lastUsage=getCpuUsage(); setInterval(()=>{ const curr=getCpuUsage(); const load=1-(curr.totalIdle-lastUsage.totalIdle)/(curr.totalTick-lastUsage.totalTick); lastUsage=curr; const desired=Math.max(1,Math.min(os.cpus().length*2,Math.round(load*os.cpus().length*2))); const diff=desired-workers.length; if(diff>0) workers.push(...spawnWorkers(diff,logUsage,summaryCollector,"local")); else if(diff<0) for(let i=0;i<-diff;i++) workers.pop().terminate(); },2000); }

  if(listenPort){
    const vramPool=new NetworkedPool(), vvmPool=new NetworkedPool();
    const server=net.createServer((socket)=>{
      console.log("Remote client connected.");
      let buffer="";
      socket.on("data",(data)=>{
        buffer+=data.toString(); let lines=buffer.split("\n"); buffer=lines.pop();
        for(const line of lines){ if(!line.trim()) continue;
          try{ const msg=JSON.parse(line); if(msg.id.startsWith("remote-vram-")) vramPool.addReport(msg); else if(msg.id.startsWith("remote-vvm-")) vvmPool.addReport(msg); else if(logUsage&&summaryCollector) summaryCollector.add(msg.id,msg.ticks); }
          catch(e){ console.error("Invalid message from client:",line); }
        }
      });
      socket.on("end",()=>console.log("Remote client disconnected."));
    });
    server.listen(listenPort,()=>console.log(`Listening for remote clients on port ${listenPort}...`));
    setInterval(()=>{vramPool.summary("vRAM"); vvmPool.summary("vVM");},5000);
  }
}

main();

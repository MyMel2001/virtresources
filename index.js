// VirtResources
// Host:   virtresources <app> [vcpus] [--autoscale] [--log] [--listen <port>] [app_args...]
// Client: virtresources --connect <host>:<port> [vcpus] [--autoscale] [--log]

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import net from "net";
import { create, globals } from "webgpu";

Object.assign(globalThis, globals); // GPUBufferUsage and other constants now available globally

// --- Virtual CPU Helpers ---
function spawnWorkers(count, logUsage=false, summaryCollector=null, prefix="local") {
  console.log(`Spawning ${count} ${prefix} virtual CPUs...`);
  const workers = [];
  for(let i=0;i<count;i++){
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      let busyTicks=0;
      setInterval(()=>busyTicks++,1000);
      setInterval(()=>{
        parentPort.postMessage({busyTicks});
        busyTicks=0;
      },2000);
    `,{eval:true});

    if(logUsage && summaryCollector){
      worker.on('message',msg=>summaryCollector.add(`${prefix}-${i}`,msg.busyTicks));
    }
    workers.push(worker);
  }
  return workers;
}

// --- Worker Summary ---
class WorkerSummary {
  constructor(interval=2000){
    this.stats={};
    setInterval(()=>this.printSummary(),interval);
  }
  add(id,ticks){ this.stats[id]=ticks; }
  printSummary(){
    const entries = Object.entries(this.stats);
    const sumTicks = arr => arr.reduce((a, [,v])=>a+v,0);
    const activeCount = arr => arr.filter(([,v])=>v>0).length;
    const local = entries.filter(([id])=>id.startsWith("local-"));
    const remote = entries.filter(([id])=>id.startsWith("remote-"));
    console.log(`[Summary] Local: ${activeCount(local)} workers, ${sumTicks(local)} ticks | `+
                `Remote: ${activeCount(remote)} workers, ${sumTicks(remote)} ticks`);
    this.stats={};
  }
}

// --- CPU Usage Helper ---
function getCpuUsage(){
  const cpus = os.cpus();
  let totalIdle=0,totalTick=0;
  for(const cpu of cpus){
    for(const t in cpu.times) totalTick+=cpu.times[t];
    totalIdle+=cpu.times.idle;
  }
  return {totalIdle,totalTick};
}

// --- Virtual RAM ---
class VirtualRAM {
  constructor(sizeMB=512){
    this.buffer = Buffer.alloc(sizeMB*1024*1024);
    console.log(`Allocated ${sizeMB} MB of virtual RAM`);
  }
  read(offset=0,length=this.buffer.length){ return this.buffer.slice(offset,offset+length); }
  write(data,offset=0){ 
    if(Buffer.isBuffer(data)) data.copy(this.buffer,offset);
    else this.buffer.set(data,offset);
  }
}

// --- Virtual GPU RAM ---
class VirtualGPUMemory {
  constructor(sizeBytes=256*1024*1024){ // default 256MB
    this.size = sizeBytes;
    this.device=null;
    this.gpuBuffer=null;
    this.cpuFallback = Buffer.alloc(sizeBytes);
  }

  async init(){
    try {
      const navigator={gpu:create()};
      this.adapter = await navigator.gpu.requestAdapter({powerPreference:"high-performance"});
      this.device = await this.adapter.requestDevice();
      this.gpuBuffer = this.device.createBuffer({
        size: this.size,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE
      });
      console.log(`Allocated ${this.size/1024/1024} MB of GPU-backed virtual memory`);
    } catch(err){
      console.warn("GPU unavailable, using CPU fallback memory:",err.message);
      this.device=null;
    }
  }

  async write(offset,data){
    if(this.device && this.gpuBuffer){
      await this.gpuBuffer.mapAsync(GPUBufferUsage.MAP_WRITE);
      const array = new Uint8Array(this.gpuBuffer.getMappedRange());
      array.set(data, offset);
      this.gpuBuffer.unmap();
    } else {
      this.cpuFallback.set(data, offset);
    }
  }

  async read(offset=0,length=this.size){
    if(this.device && this.gpuBuffer){
      await this.gpuBuffer.mapAsync(GPUBufferUsage.MAP_READ);
      const array = new Uint8Array(this.gpuBuffer.getMappedRange(offset,length));
      const copy = new Uint8Array(array);
      this.gpuBuffer.unmap();
      return copy;
    } else {
      return this.cpuFallback.slice(offset,offset+length);
    }
  }
}

// --- Networked GPU RAM ---
class NetworkedGPU {
  constructor(vgpu, port=null){
    this.vgpu = vgpu;
    this.clients = [];
    if(port){
      this.server = net.createServer(socket=>{
        console.log("Networked GPU client connected");
        this.clients.push(socket);
        socket.on("end",()=>{
          this.clients = this.clients.filter(c=>c!==socket);
          console.log("Client disconnected");
        });
      });
      this.server.listen(port,()=>console.log(`Networked GPU server listening on port ${port}`));

      setInterval(async ()=>{
        const frame = await this.vgpu.read();
        const buf = Buffer.from(frame.buffer || frame); // support typed array or Buffer
        for(const c of this.clients) c.write(buf);
      },33); // ~30FPS
    }
  }
}

// --- Main Function ---
async function main(){
  const args = process.argv.slice(2);
  if(args.length<1){
    console.log("Usage:");
    console.log("Host: virtresources <app> [vcpus] [--autoscale] [--log] [--listen <port>] [app_args...]");
    console.log("Client: virtresources --connect <host>:<port> [vcpus] [--autoscale] [--log]");
    process.exit(1);
  }

  let app=null,vcpus=os.cpus().length,autoscale=false,logUsage=false;
  let appArgs=[],listenPort=null,connectTarget=null;

  for(let i=0;i<args.length;i++){
    if(args[i]==="--autoscale") autoscale=true;
    else if(args[i]==="--log") logUsage=true;
    else if(args[i]==="--listen") listenPort=parseInt(args[++i],10);
    else if(args[i]==="--connect") connectTarget=args[++i];
    else if(!isNaN(parseInt(args[i]))) vcpus=parseInt(args[i],10);
    else if(!app) app=args[i];
    else appArgs.push(args[i]);
  }

  const summaryCollector = logUsage ? new WorkerSummary() : null;
  const localRAM = new VirtualRAM(512);
  const localGPU = new VirtualGPUMemory(256*1024*1024); // 256MB GPU RAM
  await localGPU.init();
  const networkedGPU = listenPort ? new NetworkedGPU(localGPU, listenPort) : null;

  // --- Client Mode ---
  if(connectTarget){
    const [host, portStr] = connectTarget.split(":");
    const port=parseInt(portStr,10);
    const socket = net.createConnection({host,port},()=>console.log(`Connected to host ${host}:${port}`));
    spawnWorkers(vcpus, logUsage, { add:(id,ticks)=>socket.write(JSON.stringify({id,ticks})+"\n") },"remote");
    await new Promise(()=>{}); // keep alive
  }

  // --- Host Mode ---
  if(!app){ console.error("Host mode requires an application."); process.exit(1); }
  const appProc = spawn(app,appArgs,{stdio:"inherit",shell:os.platform()!=="win32"});
  const workers = spawnWorkers(vcpus,logUsage,summaryCollector,"local");

  // Auto-scaling
  if(autoscale){
    let lastUsage = getCpuUsage();
    setInterval(()=>{
      const curr = getCpuUsage();
      const idleDiff = curr.totalIdle-lastUsage.totalIdle;
      const totalDiff = curr.totalTick-lastUsage.totalTick;
      const load = 1-idleDiff/totalDiff;
      lastUsage = curr;
      const desired = Math.max(1,Math.min(os.cpus().length*2,Math.round(load*os.cpus().length*2)));
      const diff = desired-workers.length;
      if(diff>0) workers.push(...spawnWorkers(diff,logUsage,summaryCollector,"local"));
      else if(diff<0) for(let i=0;i<-diff;i++) workers.pop().terminate();
    },2000);
  }
}

main();

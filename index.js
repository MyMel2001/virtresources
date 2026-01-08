#!/usr/bin/env node
// VirtResources: vCPU, RAM, GPU RAM (TensorFlow.js) simulation with networking and scaling

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import net from "net";
import path from "path";
import * as tf from "@tensorflow/tfjs";

// -------------------- Helpers --------------------

function spawnWorkers(count, logUsage = false, summaryCollector = null, prefix = "local") {
  const workers = [];
  for (let i = 0; i < count; i++) {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      let busyTicks = 0;
      // Simulate CPU load
      setInterval(() => { 
        for(let i=0; i<1e6; i++) { Math.sqrt(i); }
        busyTicks++; 
      }, 100);
      setInterval(() => {
        parentPort.postMessage({ busyTicks });
        busyTicks = 0;
      }, 2000);
    `, { eval: true });

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
    const activeCount = (arr) => arr.filter(([,v]) => v>0).length;

    console.log(`[Summary] Local: ${activeCount(local)} workers, ${sumTicks(local)} ticks | ` +
                `Remote: ${activeCount(remote)} workers, ${sumTicks(remote)} ticks`);
    this.stats = {};
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

function isCLI(appPath) {
  const ext = path.extname(appPath).toLowerCase();
  if (process.platform === "win32") return ext === ".exe" || ext === ".bat" || ext === ".cmd";
  return true;
}

// -------------------- Virtual RAM --------------------

class VirtualRAM {
  constructor(sizeMB = 512, name = "VirtualRAM") {
    this.sizeMB = sizeMB;
    this.buffer = Buffer.alloc(sizeMB * 1024 * 1024);
    this.size = this.buffer.length; // quick hot fix.
    console.log(`[VirtualRAM] Allocated ${sizeMB} MB`);
  }

  write(offset, data) {
    if (offset + data.length > this.size) {
       console.warn("[VirtualRAM] Out of bounds write attempted, truncating");
       data = data.slice(0, this.size - offset);
    }
    if (data.length > 0) data.copy(this.buffer, offset);
  }

  read(offset, length) {
    if (offset + length > this.size) {
      console.warn("[VirtualRAM] Out of bounds read attempted, truncating");
      length = this.size - offset;
    }
    return length > 0 ? this.buffer.slice(offset, offset+length) : Buffer.alloc(0);
  }

  fill(value) {
    this.buffer.fill(value);
  }
}

// -------------------- Virtual GPU RAM --------------------

class VirtualGPURAM {
  constructor(sizeMB = 256, name = "VirtualGPURAM") {
    this.size = sizeMB * 1024 * 1024;
    // We use a segmented approach to avoid massive single-array allocations
    this.segmentSize = 10 * 1024 * 1024; // 10MB segments
    this.segments = [];
    const numSegments = Math.ceil(this.size / this.segmentSize);
    
    for (let i = 0; i < numSegments; i++) {
      const currentSegmentSize = Math.min(this.segmentSize, this.size - i * this.segmentSize);
      this.segments.push(tf.variable(tf.zeros([currentSegmentSize])));
    }

    this.name = name;
    console.log(`[${this.name}] Allocated ${sizeMB} MB of virtual GPU memory in ${numSegments} segments`);
  }

  _getSegmentAndOffset(offset) {
    const segIndex = Math.floor(offset / this.segmentSize);
    const segOffset = offset % this.segmentSize;
    return { segIndex, segOffset };
  }

  write(offset, data) {
    if (offset + data.length > this.size) {
       console.warn("[VirtualGPURAM] Out of bounds write attempted");
       return;
    }
    
    let bytesWritten = 0;
    while (bytesWritten < data.length) {
      const { segIndex, segOffset } = this._getSegmentAndOffset(offset + bytesWritten);
      const segment = this.segments[segIndex];
      const remainingInSegment = this.segmentSize - segOffset;
      const toWrite = Math.min(data.length - bytesWritten, remainingInSegment);
      
      const chunk = data.slice(bytesWritten, bytesWritten + toWrite);
      
      tf.tidy(() => {
        const sub = tf.tensor(chunk);
        const oldVal = segment.read();
        const newVal = tf.concat([
          oldVal.slice([0], [segOffset]),
          sub,
          oldVal.slice([segOffset + toWrite])
        ]);
        segment.assign(newVal);
      });
      
      bytesWritten += toWrite;
    }
  }

  read(offset, length) {
    if (offset + length > this.size) {
       console.warn("[VirtualGPURAM] Out of bounds read attempted");
       length = this.size - offset;
    }
    if (length <= 0) return new Float32Array(0);

    const result = new Float32Array(length);
    let bytesRead = 0;
    
    while (bytesRead < length) {
      const { segIndex, segOffset } = this._getSegmentAndOffset(offset + bytesRead);
      const segment = this.segments[segIndex];
      const remainingInSegment = this.segmentSize - segOffset;
      const toRead = Math.min(length - bytesRead, remainingInSegment);
      
      const chunk = segment.slice([segOffset], [toRead]).dataSync();
      result.set(chunk, bytesRead);
      
      bytesRead += toRead;
    }
    
    return result;
  }

  fill(value) {
    for (const segment of this.segments) {
      segment.assign(tf.fill(segment.shape, value));
    }
  }

  compute(fn) {
    for (const segment of this.segments) {
      segment.assign(fn(segment));
    }
  }
}

// -------------------- Network Server --------------------

class NetworkServer {
  constructor(listenPort) {
    this.listenPort = listenPort;
    this.clients = [];
    this.resources = []; // All registered resources: CPU, RAM, GPU

    this.server = net.createServer(socket => {
      console.log("Remote client connected");
      this.clients.push(socket);

      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let lines = buffer.split("\n");
        buffer = lines.pop();

        for(const line of lines){
          if(!line.trim()) continue;
          try{
            const msg = JSON.parse(line);
            for(const res of this.resources){
              res.handleMessage(msg, socket);
            }
          }catch(e){
            console.error("Invalid client message", e);
          }
        }
      });

      socket.on("end", () => {
        console.log("Client disconnected");
        this.clients = this.clients.filter(c=>c!==socket);
      });
    });

    this.server.listen(listenPort, () => console.log(`Listening for remote clients on port ${listenPort}`));
  }

  registerResource(resource) {
    this.resources.push(resource);
  }
}

// -------------------- Main --------------------

async function main(){
  const args = process.argv.slice(2);
  if(args.length<1){
    console.log("Usage:\n Host: virtresources <app> [vcpus] [--autoscale] [--log] [--listen <port>] [--ram <mb>] [--gpu <mb>] [app_args...]\n Client: virtresources --connect <host>:<port> [vcpus] [--autoscale] [--log]");
    process.exit(1);
  }

  let app=null, vcpus=os.cpus().length, autoscale=false, logUsage=false;
  let appArgs=[], listenPort=null, connectTarget=null;
  let ramMB=512, gpuMB=0;

  for(let i=0;i<args.length;i++){
    if(args[i]=="--autoscale") autoscale=true;
    else if(args[i]=="--log") logUsage=true;
    else if(args[i]=="--listen") listenPort=parseInt(args[++i]);
    else if(args[i]=="--connect") connectTarget=args[++i];
    else if(args[i]=="--ram") ramMB=parseInt(args[++i]);
    else if(args[i]=="--gpu") gpuMB=parseInt(args[++i]);
    else if(!isNaN(parseInt(args[i]))) vcpus=parseInt(args[i]);
    else if(!app) app=args[i];
    else appArgs.push(args[i]);
  }

  if(vcpus<=0 && ramMB<=0 && gpuMB<=0){
    console.error("❌ Must allocate at least one resource (vCPU, RAM, or GPU RAM)");
    process.exit(1);
  }

  const summaryCollector = logUsage ? new WorkerSummary() : null;
  const localRAM = ramMB>0 ? new VirtualRAM(ramMB) : null;
  if (ramMB > 0) {
    console.log(`[Init] Virtual RAM ready: ${ramMB || 0} MB`);
  }
  const localVV  = gpuMB>0 ? new VirtualGPURAM(gpuMB) : null;
  if (gpuMB > 0) {
    console.log(`[Init] Virtual GPU Mem ready: ${gpuMB || 0} MB`);
  }

  // -------------------- Network --------------------
  const netServer = listenPort ? new NetworkServer(listenPort) : null;

  if(localRAM && netServer){
    localRAM.handleMessage = (msg)=>{
      if(msg.type==="write") localRAM.write(msg.offset, Buffer.from(msg.data));
    };
    netServer.registerResource(localRAM);
  }

  if(localVV && netServer){
    localVV.handleMessage = (msg)=>{
      if(msg.type==="writeGPU") localVV.write(msg.offset, msg.data);
    };
    netServer.registerResource(localVV);
  }

  if(vcpus>0 && netServer){
    netServer.registerResource({
      handleMessage: (msg)=>{
        if(msg.type==="vCPU") {
           const remoteWorkers = spawnWorkers(msg.count, logUsage, summaryCollector,"remote");
           workers.push(...remoteWorkers);
        }
      }
    });
  }

  const workers = [];

  // -------------------- Client Mode --------------------
  if(connectTarget){
    const [host, portStr] = connectTarget.split(":");
    const port = parseInt(portStr,10);
    const socket = net.createConnection({host,port},()=>console.log(`[Client] Connected to host ${host}:${port}`));

    // Send vCPU count
    socket.write(JSON.stringify({type:"vCPU", count:vcpus})+"\n");

    const workers = spawnWorkers(vcpus, logUsage, {
      add: (id, ticks)=>socket.write(JSON.stringify({ type:"ticks", id, ticks })+"\n")
    }, "remote");

    if (vcpus > 0) {
      console.log(`[Init] Virtual CPUs sent: ${vcpus || 0}`);
    }

    await new Promise(()=>{}); // keep alive
  }

  // -------------------- Host Mode --------------------
  if(!app){
    console.error("Host mode requires an application to run.");
    process.exit(1);
  }

  spawn(app, appArgs, { stdio:"inherit", shell:os.platform()!=="win32" });
  workers.push(...spawnWorkers(vcpus, logUsage, summaryCollector, "local"));
  if (vcpus > 0) {
    console.log(`[Init] Virtual CPUs ready: ${vcpus || 0}`);
  }

  // Auto-scaling
  if(autoscale){
    let lastUsage = getCpuUsage();
    setInterval(()=>{
      const currUsage = getCpuUsage();
      const idleDiff = currUsage.totalIdle - lastUsage.totalIdle;
      const totalDiff = currUsage.totalTick - lastUsage.totalTick;
      const load = 1 - idleDiff/totalDiff;
      lastUsage = currUsage;

      const desiredVCPUs = Math.max(1, Math.min(os.cpus().length*2, Math.round(load*os.cpus().length*2)));
      const diff = desiredVCPUs - workers.length;
      if(diff>0) workers.push(...spawnWorkers(diff, logUsage, summaryCollector, "local"));
      else if(diff<0) for(let i=0;i<-diff;i++) workers.pop().terminate();
    },2000);
  }
}

main();

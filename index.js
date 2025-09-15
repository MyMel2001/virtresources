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
      setInterval(() => { busyTicks++; }, 1000);
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
    this.size = sizeMB * 1024 * 1024;
    this.buffer = Buffer.alloc(this.size);
    this.name = name;
    console.log(`[${this.name}] Allocated ${sizeMB} MB of virtual RAM`);
  }

  write(offset, data) {
    if (offset + data.length > this.size) throw new Error("Out of bounds write");
    data.copy(this.buffer, offset);
  }

  read(offset, length) {
    if (offset + length > this.size) throw new Error("Out of bounds read");
    return this.buffer.slice(offset, offset+length);
  }

  fill(value) {
    this.buffer.fill(value);
  }
}

// -------------------- Virtual GPU RAM --------------------

class VirtualGPURAM {
  constructor(sizeMB = 256, name = "VirtualGPURAM") {
    this.size = sizeMB * 1024 * 1024;
    this.tensor = tf.tensor(new Float32Array(this.size), [this.size]);
    this.name = name;
    console.log(`[${this.name}] Allocated ${sizeMB} MB of virtual GPU memory`);
  }

  write(offset, data) {
    if (offset + data.length > this.size) throw new Error("Out of bounds write");
    const sub = tf.tensor(data);
    this.tensor = tf.concat([
      this.tensor.slice([0],[offset]),
      sub,
      this.tensor.slice([offset+data.length])
    ]);
  }

  read(offset, length) {
    if (offset + length > this.size) throw new Error("Out of bounds read");
    return this.tensor.slice([offset], [length]).dataSync();
  }

  fill(value) {
    this.tensor = tf.fill([this.size], value);
  }

  compute(fn) {
    this.tensor = fn(this.tensor);
  }
}

// -------------------- Networked Memory & vCPUs --------------------

class NetworkedResource {
  constructor(localResource, listenPort = null, type="RAM") {
    this.localResource = localResource;
    this.type = type;
    this.clients = [];

    if(listenPort){
      const server = net.createServer(socket => {
        console.log(`Networked client connected for ${type}`);

        let buffer = "";
        socket.on("data", (data) => {
          buffer += data.toString();
          let lines = buffer.split("\n");
          buffer = lines.pop();

          for(const line of lines){
            if(!line.trim()) continue;
            try{
              const msg = JSON.parse(line);

              if(msg.type==="vCPU" && type==="CPU" && msg.count>0){
                console.log(`Client contributes ${msg.count} vCPUs`);
                spawnWorkers(msg.count, true, summaryCollector, "remote");
              }

              if(msg.type==="write" && localResource){
                localResource.write(msg.offset, Buffer.from(msg.data));
              }

              if(msg.type==="writeGPU" && localResource){
                localResource.write(msg.offset, msg.data);
              }

            }catch(e){ console.error("Invalid message from client:", e);}
          }
        });

        socket.on("end", () => {
          console.log("Client disconnected from networked resource");
        });

        this.clients.push(socket);
      });

      server.listen(listenPort, ()=>console.log(`Listening for remote clients on port ${listenPort} (${type})`));
    }
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
  const localVV  = gpuMB>0 ? new VirtualGPURAM(gpuMB) : null;

  // Networked resources
  const networkedCPU = listenPort && vcpus>0 ? new NetworkedResource(null, listenPort, "CPU") : null;
  const networkedRAM = listenPort && localRAM ? new NetworkedResource(localRAM, listenPort, "RAM") : null;
  const networkedVV  = listenPort && localVV ? new NetworkedResource(localVV, listenPort, "GPU") : null;

  // Client Mode
  if(connectTarget){
    const [host, portStr] = connectTarget.split(":");
    const port = parseInt(portStr,10);
    const socket = net.createConnection({host,port},()=>console.log(`[Client] Connected to host ${host}:${port}`));

    // Send vCPU count
    socket.write(JSON.stringify({type:"vCPU", count:vcpus})+"\n");

    const workers = spawnWorkers(vcpus, logUsage, {
      add: (id, ticks)=>socket.write(JSON.stringify({ type:"ticks", id, ticks })+"\n")
    }, "remote");

    await new Promise(()=>{}); // keep alive
  }

  // Host Mode
  if(!app){
    console.error("Host mode requires an application to run.");
    process.exit(1);
  }

  spawn(app, appArgs, { stdio:"inherit", shell:os.platform()!=="win32" });
  const workers = spawnWorkers(vcpus, logUsage, summaryCollector, "local");

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

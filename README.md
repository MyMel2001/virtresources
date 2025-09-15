# VirtResources

**VirtResources** is a cross-platform Node.js tool for simulating additional system resources, including virtual CPUs, virtual RAM, and virtual video memory (vVM). It supports both **local** and **networked modes**, allowing multiple computers to pool their resources into a single virtualized system environment.

---

## Features

- **Virtual CPUs (vCPU)**: Simulate extra CPU threads to enhance application parallelism.  
- **Virtual RAM (vRAM)**: Allocate virtual CPU memory, usable locally or pooled over networked machines.  
- **Virtual Video Memory (vVM)**: Allocate virtual GPU memory, accelerated using Tensorflow. Networked mode allows multiple machines to combine GPU memory.  
- **Networked Resource Sharing**: Connect clients to a host to combine vCPU, vRAM, and vVM resources across machines.  
- **Auto-Scaling**: Optional auto-adjustment of virtual CPUs based on system load.  
- **Cross-Platform**: Works on Windows, macOS, and Linux.  
- **GUI Support**: Applications with GUIs remain attached to the terminal or desktop.  

---

## However

* Virtual Resoruces ≠ number of hardware detected.
* More virtual resources ≠ always better — test with your app/physical hardware to find the sweet spot.
* Overhead is minimal, but spawning too many workers can cause OS context-switching slowdown.

---
## Installation

```bash
git clone <repo-url>
cd virtresources
npm install
```

---

## Usage

### Host Mode

The host runs the main application and listens for remote clients:

**Example:**

```bash
node virtresources.js ./serverApp --ram 1024 --listen 9000
```

### Client Mode

Clients connect to a host to contribute resources:

**Example:**

```bash
node virtresources.js --connect 127.0.0.1:9000 --cpus 2
```

### Solo w/ Virtual GPU RAM *and* CPUs

**Example:**

```bash
node virtresources.js ./workerApp --cpus 4 --gpu 256
```

### Solo RAM only /w App Args

```bash
node virtresources.js ./myapp --foo bar --ram 512 
```

### All resources together
```bash
node virtresources.js ./bigApp --ram 512 --gpu 128 --cpus 8 
```

### Autoscaling + logging

```bash
node virtresources.js ./scaleTest --ram 256 --gpu 256 --cpus 2 --autoscale --log
```

### Ultra host computer.

```bash
node virtresources.js ./giantApp --ram 256 --gpu 256 --cpus 2 --autoscale --log --listen 9000
```
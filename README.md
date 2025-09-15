# VirtResources

**VirtResources** is a cross-platform Node.js tool for simulating additional system resources, including virtual CPUs, virtual RAM, and virtual video memory (vVM). It supports both **local** and **networked modes**, allowing multiple computers to pool their resources into a single virtualized system environment.

---

## Features

- **Virtual CPUs (vCPU)**: Simulate extra CPU threads to enhance application parallelism.  
- **Virtual RAM (vRAM)**: Allocate virtual CPU memory, usable locally or pooled over networked machines.  
- **Virtual Video Memory (vVM)**: Allocate virtual GPU memory, optionally accelerated using Vulkan. Networked mode allows multiple machines to combine GPU memory.  
- **Networked Resource Sharing**: Connect clients to a host to combine CPU, RAM, and vVM resources across machines.  
- **Auto-Scaling**: Optional auto-adjustment of virtual CPUs based on system load.  
- **Cross-Platform**: Works on Windows, macOS, and Linux.  
- **GUI Support**: Applications with GUIs remain attached to the terminal or desktop.  

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
node virtresources.js --ram 1024 --listen 9000 ./serverApp
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
node virtresources.js --cpus 4 --gpu 256 ./workerApp
```

### Solo RAM only

```bash
node virtresources.js --ram 512 ./myapp --foo bar
```

### All resources together
```bash
node virtresources.js --ram 512 --gpu 128 --cpus 8 ./bigApp
```

### Autoscaling + logging

```bash
node virtresources.js --ram 256 --gpu 256 --cpus 2 --autoscale --log ./scaleTest
```

### Ultra host computer.

```bash
node virtresources.js --ram 256 --gpu 256 --cpus 2 --autoscale --log --listen 9000 ./giantApp
```
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

> **Optional:** Install Vulkan for GPU-accelerated virtual video memory:

```bash
npm install node-vulkan
```

---

## Usage

### Host Mode

The host runs the main application and listens for remote clients:

```bash
node index.js "<app_command>" [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log] [--listen <port>] [app_args...]
```

**Example:**

```bash
node index.js "java -jar MyGame.jar" 8 --vram 2048 --vvm 1024 --autoscale --log --listen 4020
```

### Client Mode

Clients connect to a host to contribute resources:

```bash
node index.js --connect <host_ip>:<port> [vcpus] [--vram <MB>] [--vvm <MB>] [--autoscale] [--log]
```

**Example:**

```bash
node index.js --connect 192.168.50.100:4020 4 --vram 1024 --vvm 512 --autoscale --log
```

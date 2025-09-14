# VirtCPUs  
Simulate extra virtual CPUs for any external application (CLI or GUI) using Node.js worker threads.  

This wrapper launches an app and spawns additional “virtual CPU” threads, giving the OS scheduler more contexts to work with.  
Useful for apps that benefit from parallelism (e.g., JVM apps like Minecraft Java) without modifying them.  

---

## How it works
* You run your app under this wrapper.
* The wrapper spawns N worker threads (your “virtual CPUs”).
* The wrapper intercepts the app’s stdout, stdin, socket traffic, etc(?).
* It distributes chunks of work to those worker threads.
* The workers do the CPU-bound part, then send results back to the app.

So the external app’s workload is effectively parallelized without it knowing.

---

## Features
- Works with **CLI and GUI apps** (keeps them attached).  
- Supports **custom virtual CPU counts**.  
- **Auto-scaling mode** adjusts virtual CPUs dynamically based on load.  
- Optional **logging**: see per-worker summaries in real time.  
- Cross-platform: **Windows, macOS, Linux**.  
- Packaged with **Electron Forge** for easy distribution.  

---

## Usage
### Command
```bash
virtcpus <app> [virtual_cpus] [--autoscale] [--log] [app_args...]
```

## Examples

* Run CLI app with default cores:
```bash
virtcpus ./myCLIApp
```
* Run GUI app (Windows example) with 12 virtual CPUs:
```batch
virtcpus notepad.exe 12
```
* Enable auto-scaling and logging:
```
virtcpus ./myApp 8 --autoscale --log
```

## Building

This project is packaged with Electron Forge for convenience.

* Install dependencies:
```bash
npm install
```
* Run locally:

```bash
npm start
```
* Package into a binary (all platforms):

```bash
npm run package
```

Resulting binaries will be in the out/ folder.

## Notes

* Virtual CPUs ≠ number of physical cores detected.
* More virtual CPUs ≠ always better — test with your app to find the sweet spot.
* Overhead is minimal, but spawning too many workers can cause OS context-switching slowdown.
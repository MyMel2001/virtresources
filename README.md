# virtcpus

Run app with "virtual CPUs" in NodeJS. (Inspired by SoftRam.)

## How it works

* You run your app under this wrapper.
* The wrapper spawns N worker threads (your “virtual CPUs”).
* The wrapper intercepts the app’s stdout (or stdin, or socket traffic).
* It distributes chunks of work to those worker threads.
* The workers do the CPU-bound part, then send results back to the app.

So the external app’s workload is effectively parallelized without it knowing.
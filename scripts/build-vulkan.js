import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Detect OS
const platform = os.platform();
console.log(`Detected platform: ${platform}`);

// Function to run shell commands
function runCommand(cmd, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { cwd }, (error, stdout, stderr) => {
      if (error) return reject({ error, stdout, stderr });
      resolve({ stdout, stderr });
    });
    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);
  });
}

// Check Vulkan SDK environment variable
const vulkanEnvVar = platform === "win32" ? "VULKAN_SDK" : "VULKAN_SDK";
const vulkanPath = process.env[vulkanEnvVar];

if (!vulkanPath) {
  console.error(`❌ Vulkan SDK not found! Please install it and set ${vulkanEnvVar}.`);
  process.exit(1);
}

console.log(`Found Vulkan SDK at: ${vulkanPath}`);
console.log("Building node-vulkan...");

(async () => {
  try {
    // Install node-vulkan native bindings
    await runCommand("npm rebuild node-vulkan");
    console.log("✅ node-vulkan successfully built with Vulkan SDK.");
  } catch (err) {
    console.error("❌ Failed to build node-vulkan:");
    console.error(err.stderr || err.error);
    process.exit(1);
  }
})();

import { TunTap } from "../lib/index.js";

let tun;
let shuttingDown = false;

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    tun?.isOpen && !tun.isClosed && tun.close();
  } catch {}
}

process.on("exit", cleanup);

// Handle signals and exit
function cleanupAndExit() {
  cleanup();
  process.exit(0);
}

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

async function main() {
  tun = new TunTap();
  tun.open();
  await tun.configure("fd00::1", 1500);
  await tun.addRoute("fd00::/64");

  // Print the expected output for the test to detect
  console.log("Step 4: Testing read/write");

  // Wait indefinitely until SIGINT is received
  setInterval(() => {}, 1000);
}

main();

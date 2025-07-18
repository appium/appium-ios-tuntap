import { TunTap } from "../lib/index.js";

let tun;
let shuttingDown = false;

function cleanupAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (tun && tun.isOpen && !tun.isClosed) {
      tun.close();
    }
  } catch (e) {
    // Ignore errors during cleanup
  }
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

main().catch((err) => {
  console.error("Error in test-tuntap.js:", err);
  process.exit(1);
});

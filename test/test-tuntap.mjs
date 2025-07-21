import { TunTap } from "../lib/index.js";

let tun;
let shuttingDown = false;

/**
 * Cleanup function to close the TUN/TAP device.
 * Uses a flag to ensure cleanup is only performed once.
 */
function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // Only close if tun exists, is open, and not already closed
    if (tun && tun.isOpen && !tun.isClosed) {
      tun.close();
    }
  } catch (err) {
    console.error("Error during cleanup:", err);
  }
}

process.once("exit", cleanup);

async function main() {
  tun = new TunTap();
  tun.open();
  await tun.configure("fd00::1", 1500);
  await tun.addRoute("fd00::/64");

  while (tun.isOpen) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

main();

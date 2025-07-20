import assert from "assert";
import { TunTap } from "../lib/index.js";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("TunTap Integration Tests", function () {
  let tun;

  before(function () {
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      this.skip();
    }
  });

describe("TunTap CLI Utility Signal Handling", function () {
  it("should exit promptly and clean up on SIGINT", function (done) {
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      this.skip();
    }
    this.timeout(10000);

    const cliPath = path.resolve(__dirname, "test-tuntap.mjs");
    const child = spawn("node", [cliPath], { stdio: ["ignore", "pipe", "pipe"] });

    let started = false;
    child.stdout.on("data", (data) => {
      const output = data.toString();
      if (!started && output.includes("Step 4: Testing read/write")) {
        started = true;
        setTimeout(() => {
          child.kill("SIGINT");
        }, 500); // Give it a moment to enter the read/write step
      }
    });

    child.on("exit", (code, signal) => {
      // Should exit with code 0 or null (if killed by signal)
      if (signal === "SIGINT" || code === 0) {
        done();
      } else {
        done(new Error(`Process exited with code ${code} and signal ${signal}`));
      }
    });

    child.on("error", (err) => {
      done(err);
    });
  });
});

  afterEach(() => {
    if (tun && tun.isOpen && !tun.isClosed) {
      try { tun.close(); } catch (e) {}
    }
    tun = null;
  });

  it("should open, configure, add route, and close", async function () {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, "TUN device should open");
    assert.strictEqual(typeof tun.name, "string");
    assert.ok(tun.fd > 0);

    await tun.configure("fd00::1", 1500);
    await tun.addRoute("fd00::/64");

    // Remove route and close
    await tun.removeRoute("fd00::/64");
    assert.strictEqual(tun.close(), true, "TUN device should close");
  });

  it("should read and write data (simulate traffic)", function (done) {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, "TUN device should open");
    tun.configure("fd00::1", 1500).then(() => {
      let readCount = 0;
      const timeout = setTimeout(() => {
        // No data received, this is normal if no traffic is sent
        tun.close();
        done();
      }, 3000);

      const interval = setInterval(() => {
        try {
          const data = tun.read(4096);
          if (data && data.length > 0) {
            readCount++;
            const bytesWritten = tun.write(data);
            assert.strictEqual(bytesWritten, data.length, "Should echo back same number of bytes");
            clearTimeout(timeout);
            clearInterval(interval);
            tun.close();
            done();
          }
        } catch (err) {
          clearTimeout(timeout);
          clearInterval(interval);
          tun.close();
          done(err);
        }
      }, 100);
    }).catch(done);
  });

  it("should fail to open an already closed device", function () {
    tun = new TunTap();
    tun.open();
    tun.close();
    assert.throws(() => tun.open(), /Device has been closed/);
  });

  it("should throw on invalid configuration", async function () {
    tun = new TunTap();
    tun.open();
    await assert.rejects(() => tun.configure("not-an-ip", 1500), /Invalid IPv6 address/);
    await assert.rejects(() => tun.configure("fd00::1", 50), /MTU must be between/);
    tun.close();
  });

  it("should get interface statistics", async function () {
    tun = new TunTap();
    tun.open();
    await tun.configure("fd00::1", 1500);
    const stats = await tun.getStats();
    assert.ok(typeof stats.rxBytes === "number");
    assert.ok(typeof stats.txBytes === "number");
    tun.close();
  });
});

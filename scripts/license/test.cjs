/*
 * License key tests: issue keys with the private key, then drive the built CLI
 * (activate, status, tamper, expiry, remove) in an isolated config home.
 *   node scripts/license/test.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "coolftp.js");
const ISSUE = path.join(__dirname, "issue.cjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-lic-"));
const env = { ...process.env, COOLFTP_HOME: HOME, NO_COLOR: "1" };

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra && !cond ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const cli = (args) => JSON.parse(execFileSync("node", [CLI, "--direct", "--json", ...args], { env, encoding: "utf8" }));
const cliFails = (args) => {
  try {
    execFileSync("node", [CLI, "--direct", "--json", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (e) {
    return String(e.stdout || e.stderr);
  }
};
const issue = (extra = []) => execFileSync("node", [ISSUE, "--email", "Buyer@Example.com", ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

console.log("license");
const free = cli(["license"]);
check("fresh install is Free", free.installed === false && free.pro === false);

const key = issue();
check("issued key has the expected shape", /^CFP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key));

const act = cli(["license", "activate", key]);
check("activate: pro on, email lowercased, 3 seats", act.pro === true && act.license.email === "buyer@example.com" && act.license.seats === 3, JSON.stringify(act));

const status = cli(["license"]);
check("status persists across runs", status.pro === true && status.installed === true);

const tampered = key.replace(/\.([A-Za-z0-9_-]+)$/, (m, sig) => "." + (sig[0] === "A" ? "B" : "A") + sig.slice(1));
const bad = cliFails(["license", "activate", tampered]);
check("tampered signature is rejected", bad !== null && /signature/i.test(bad), bad);

const garbage = cliFails(["license", "activate", "hello-there"]);
check("garbage is rejected", garbage !== null && /not a coolFTP license key/i.test(garbage), garbage);

// A key whose updates window ended before this build's date.
const old = issue(["--from", "2020-01-01", "--days", "30"]);
const expired = cliFails(["license", "activate", old]);
check("activate accepts an expired-updates key (still valid, runs as Free)", expired === null);
const st2 = cli(["license"]);
check("expired-updates key: valid but not pro, with a renew hint", st2.valid === true && st2.pro === false && /Renew/.test(st2.reason), JSON.stringify(st2));

const rm = cli(["license", "remove"]);
check("remove", rm.removed === true && rm.status.installed === false);

// The stored key must not be sent to agents in plain form through 'sites' etc.; just sanity check the file exists after activate.
cli(["license", "activate", key]);
check("license.json written in config home", fs.existsSync(path.join(HOME, "license.json")));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

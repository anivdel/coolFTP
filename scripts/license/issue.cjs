/*
 * Issue a coolFTP Pro license key by hand (support, refunds, gifts, testing).
 *   node scripts/license/issue.cjs --email someone@example.com [--days 365] [--seats 3] [--from YYYY-MM-DD]
 * Needs scripts/license/private/signing.pem from keygen.cjs.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
if (!args.email) {
  console.error("usage: node scripts/license/issue.cjs --email <email> [--days 365] [--seats 3] [--from YYYY-MM-DD]");
  process.exit(1);
}
const pem = fs.readFileSync(path.join(__dirname, "private", "signing.pem"), "utf8");
const from = args.from ? new Date(args.from + "T00:00:00Z") : new Date();
const until = new Date(from.getTime() + Number(args.days || 365) * 86400000);
const day = (d) => d.toISOString().slice(0, 10);
const payload = { v: 1, id: crypto.randomBytes(5).toString("hex"), email: String(args.email).trim().toLowerCase(), tier: "pro", seats: Number(args.seats || 3), issued: day(from), updatesUntil: day(until) };
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const body = b64url(JSON.stringify(payload));
const sig = crypto.sign(null, Buffer.from(`CFP1.${body}`), crypto.createPrivateKey(pem));
console.log(`CFP1.${body}.${b64url(sig)}`);
console.error(JSON.stringify(payload));

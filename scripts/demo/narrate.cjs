/*
 * AI voiceover for the demo: synthesizes each narration line with Microsoft Edge's
 * neural voices (free, online), places every line at its cue on a silent track,
 * and muxes the result into site/demo.mp4.
 *   node scripts/demo/narrate.cjs            (run after `npm run demo`)
 *   VOICE=en-US-AvaNeural node scripts/demo/narrate.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const ROOT = path.resolve(__dirname, "..", "..");
const AUDIO = path.join(__dirname, "audio");
const VIDEO = path.join(ROOT, "site", "demo.mp4");
const VOICE = process.env.VOICE || "en-US-AndrewNeural";
const ffmpeg = process.env.FFMPEG || require("ffmpeg-static");

// Cue (ms into the video) and text. Keep each line inside its scene; timings mirror demo.html.
const LINES = [
  [300, "This is coolFTP. The FTP client your coding agent can drive."],
  [5600, "You wrote the code with your agent. Then you drag files by hand."],
  [10000, "Did pricing dot html go up? Which version is live?"],
  [13700, "Nobody knows."],
  [15400, "Now, say the word."],
  [18200, "Your agent calls coolFTP, and you watch it happen live in the app."],
  [22700, "Only the files that changed go up. Hashes, not timestamps."],
  [26900, "Then it checks that the site actually answers."],
  [30700, "And every deploy records the git commit that went live."],
  [36500, "Only what changed goes up. Timestamps lie. Hashes do not."],
  [41300, "Roll back to the previous version in one command."],
  [46100, "Agents ask before they delete. No answer means no."],
  [50900, "And deploys verify themselves, page by page."],
  [55700, "coolFTP. Free and open source, at coolftp dot com."],
];

function duration(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  if (r.status === 0) return parseFloat(r.stdout);
  // ffmpeg-static ships no ffprobe; parse ffmpeg's own header instead.
  const out = spawnSync(ffmpeg, ["-i", file], { encoding: "utf8" }).stderr;
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(out);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

async function synth(text, file) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  const chunks = [];
  await new Promise((resolve, reject) => {
    audioStream.on("data", (c) => chunks.push(c));
    audioStream.on("end", resolve);
    audioStream.on("error", reject);
  });
  fs.writeFileSync(file, Buffer.concat(chunks));
}

(async () => {
  fs.mkdirSync(AUDIO, { recursive: true });
  const clips = [];
  for (let i = 0; i < LINES.length; i++) {
    const [at, text] = LINES[i];
    const key = require("node:crypto").createHash("sha1").update(VOICE + "|" + text).digest("hex").slice(0, 10);
    const file = path.join(AUDIO, `line${String(i).padStart(2, "0")}-${key}.mp3`);
    if (!fs.existsSync(file) || process.env.FRESH) await synth(text, file);
    const d = duration(file);
    const next = LINES[i + 1] ? LINES[i + 1][0] : Infinity;
    const end = at + d * 1000;
    const overlap = end > next;
    clips.push({ at, file, d, end });
    console.log(`${String(at).padStart(6)}ms  ${d.toFixed(2)}s  ends ${Math.round(end).toString().padStart(6)}ms ${overlap ? `OVERLAPS next cue at ${next}` : ""}  ${text}`);
  }
  const total = duration(VIDEO);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", VIDEO];
  for (const c of clips) args.push("-i", c.file);
  const delayed = clips.map((c, i) => `[${i + 1}:a]adelay=${c.at}|${c.at},apad[a${i}]`).join(";");
  const mix = clips.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${clips.length}:normalize=0:dropout_transition=0,volume=1.0,atrim=0:${total}[voice]`;
  const tmp = VIDEO.replace(/\.mp4$/, ".voiced.mp4");
  args.push("-filter_complex", `${delayed};${mix}`, "-map", "0:v", "-map", "[voice]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", tmp);
  execFileSync(ffmpeg, args, { stdio: "inherit" });
  fs.renameSync(tmp, VIDEO);
  console.log(`voiceover muxed into ${VIDEO} (${VOICE}, ${clips.length} lines)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

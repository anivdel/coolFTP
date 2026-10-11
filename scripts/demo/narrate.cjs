/*
 * AI voiceover for a rendered video: synthesizes each narration line with Microsoft Edge's
 * neural voices (free, online), places every line at its cue on a silent track,
 * and muxes the result into the MP4 in place.
 *   node scripts/demo/narrate.cjs                                   (site/demo.mp4, lines below)
 *   node scripts/demo/narrate.cjs site/social-4x5.mp4 scripts/demo/social-spot.lines.cjs
 *   VOICE=en-US-AvaNeural RATE=+10% node scripts/demo/narrate.cjs
 * A cue that a slower voice would talk over is pushed back to the end of the line before it (reported as "nudged").
 * A lines file exports an array of [cueMs, text]; cached clips live in scripts/demo/audio.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const ROOT = path.resolve(__dirname, "..", "..");
const AUDIO = path.join(__dirname, "audio");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const VIDEO = path.resolve(ROOT, args[0] || path.join("site", "demo.mp4"));

const ffmpeg = process.env.FFMPEG || require("ffmpeg-static");

// Cue (ms into the video) and text. Keep each line inside its scene; timings mirror demo.html.
const DEMO_LINES = [
  [300, "This is coolFTP. An FTP client for you, and for your coding agent."],
  [5800, "Connect. Your files on the left, the server on the right."],
  [9450, "Drag a box to select."],
  [12300, "Grab them by a name, drop them across, and up they go."],
  [16200, "Every transfer gets a card: the speed, a graph of it, and pause and cancel."],
  [25600, "Deleting shows its progress too, and says when it is done."],
  [31300, "Now the part your agent does. Say the word."],
  [34000, "It calls coolFTP, and you watch it live in the app."],
  [37600, "Only the files that changed go up. Hashes, not timestamps."],
  [41800, "Then it checks that the site actually answers."],
  [46500, "Broke something? Say undo. The previous versions stayed on the server. No git needed."],
  [55300, "Hashes on the server mean only changes go up."],
  [59500, "Every upload is confirmed by the server."],
  [63700, "Agents ask before they delete. No answer means no."],
  [68000, "Big jobs open four connections."],
  [72200, "Every deploy verifies itself and spots a stale cache."],
  [76400, "Undo the last deploy, or roll back to any commit."],
  [80600, "coolFTP. Free and open source, at coolftp dot com."],
];
const LINES = args[1] ? require(path.resolve(ROOT, args[1])) : DEMO_LINES;
// A lines file may carry its own voice and rate; the environment still wins.
const VOICE = process.env.VOICE || LINES.voice || "en-US-AndrewNeural";
const RATE = process.env.RATE || LINES.rate || "";

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
  const { audioStream } = tts.toStream(text, RATE ? { rate: RATE } : undefined);
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
  let floor = 0; // earliest start for the next line: the previous line's end plus a breath
  for (let i = 0; i < LINES.length; i++) {
    const [cue, text] = LINES[i];
    const at = Math.max(cue, floor);
    const key = require("node:crypto").createHash("sha1").update(VOICE + "|" + RATE + "|" + text).digest("hex").slice(0, 10);
    const file = path.join(AUDIO, `line${String(i).padStart(2, "0")}-${key}.mp3`);
    if (!fs.existsSync(file) || process.env.FRESH) await synth(text, file);
    const d = duration(file);
    const next = LINES[i + 1] ? LINES[i + 1][0] : Infinity;
    const end = at + d * 1000;
    floor = end + 60;
    clips.push({ at, file, d, end });
    const note = at > cue ? `nudged +${at - cue}ms` : end > next ? `runs ${Math.round(end - next)}ms past next cue` : "";
    console.log(`${String(at).padStart(6)}ms  ${d.toFixed(2)}s  ends ${Math.round(end).toString().padStart(6)}ms ${note.padEnd(26)} ${text}`);
  }
  const total = duration(VIDEO);
  const last = clips[clips.length - 1];
  if (last.end > total * 1000) console.warn(`WARNING: the last line ends ${Math.round(last.end - total * 1000)}ms after the video does and will be cut off`);
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

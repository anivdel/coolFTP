// Narration for scripts/toolkit/toolkit.html (1280x720, 48s), the Claude Code Toolkit promo on each
// app's upgrade.html. Cue ms and text; each line sits inside its scene in toolkit.html's SCENES table.
//   npx electron scripts/toolkit/render.cjs && node scripts/demo/narrate.cjs site/toolkit.mp4 scripts/toolkit/lines.cjs && python scripts/toolkit/score.py
module.exports = [
  [300, "Four apps, built for Claude Code. Here's why they belong together."],
  [4800, "It starts when you spot a bug. Press Print Screen, box it, and magpie snap shows Claude exactly what you see."],
  [13300, "Some bugs you can't see. Woodpecker dig catches the crash, and hands Claude the stack trace, down to the file and line."],
  [22000, "When the problem is in your data, Owl S Q L lets Claude fix the database. And every write can be undone."],
  [30500, "Then cool F T P ships the fix, checks your site is live, and undoes a bad deploy in one step."],
  [38600, "See it. Trace it. Fix it. Ship it. Four apps built for Claude Code, with lifetime licenses, for ninety nine dollars."],
];
module.exports.voice = "en-US-AndrewNeural";
module.exports.rate = "+6%";

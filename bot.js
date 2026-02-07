import "dotenv/config";
import { App } from "@slack/bolt";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HELP_TEXT = `*Schedule Bot Commands:*
• \`today\` — today's schedule
• \`tomorrow\` — tomorrow's schedule
• \`Monday\` - \`Sunday\` — next occurrence of that day
• \`2026-02-10\` — specific date (YYYY-MM-DD)
• \`help\` — show this message`;

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;

  const text = (message.text || "").trim();
  const lower = text.toLowerCase();

  if (lower === "help" || lower === "commands") {
    await say(HELP_TEXT);
    return;
  }

  // Match a day name or YYYY-MM-DD date
  let dateArg = null;
  if (lower === "today") {
    dateArg = ""; // no arg = today
  } else if (lower === "tomorrow") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    dateArg = d.toISOString().slice(0, 10);
  } else if (DAYS.includes(lower)) {
    dateArg = text;
  } else if (DATE_RE.test(text)) {
    dateArg = text;
  }

  if (dateArg === null) return; // not a schedule request

  await say(`Generating schedule${dateArg ? " for " + dateArg : " for today"}...`);

  const args = [path.join(__dirname, "generate.js")];
  if (dateArg) args.push(dateArg);

  execFile("node", args, { cwd: __dirname, timeout: 120000 }, (err, stdout, stderr) => {
    const output = (stdout + stderr).trim();
    if (err) {
      say(`Error: ${output.split("\n").pop()}`);
    } else {
      console.log(output);
    }
  });
});

(async () => {
  await app.start();
  console.log("Bot listening for schedule requests...");
})();

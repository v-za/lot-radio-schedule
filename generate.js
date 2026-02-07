import "dotenv/config";
import HeadlessPhotopea from "headlessphotopea";
import { readPsd, writePsd, initializeCanvas } from "ag-psd";
import canvas from "canvas";
import { createCanvas as skiaCanvas, GlobalFonts } from "@napi-rs/canvas";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { fetchShows } from "./calendar.js";
import { WebClient } from "@slack/web-api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ag-psd needs node-canvas for PSD layer compositing
initializeCanvas(canvas.createCanvas, canvas.createImageData);

// Register InputMonoNarrow in Skia for our text rendering
GlobalFonts.registerFromPath(
  path.join(__dirname, "fonts", "InputMonoNarrow-Regular.ttf"),
  "InputMono"
);

const PSD_DIR = path.join(__dirname, "templates");
const OUTPUT_DIR = path.join(__dirname, "output");

function servePSD(psdPath) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(psdPath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// Find text layer inside a named group, recursively
function findTextLayer(layers, groupName) {
  for (const layer of layers) {
    if (layer.name && layer.name.indexOf(groupName) !== -1) {
      if (layer.children) {
        for (const child of layer.children) {
          if (child.text) return child;
        }
      }
      if (layer.text) return layer;
    }
    if (layer.children) {
      const found = findTextLayer(layer.children, groupName);
      if (found) return found;
    }
  }
  return null;
}

function buildScheduleText(dayName, month, dayNum, shows) {
  let text = `TODAY\r${dayName} ${month} ${dayNum}\r`;
  text += "\r";
  for (let i = 0; i < shows.length; i++) {
    const { time, name } = shows[i];
    text += `${time}\r`;
    text += `${name}`;
    if (i < shows.length - 1) text += "\r\r";
  }
  return text;
}

const DAY_MAP = {
  Sunday:    "sunday.psd",
  Monday:    "monday.psd",
  Tuesday:   "tuesday.psd",
  Wednesday: "wednesday.psd",
  Thursday:  "thursday.psd",
  Friday:    "friday.psd",
  Saturday:  "saturday.psd",
};

async function main() {
  // CLI: node generate.js [date]
  // date can be a day name ("Saturday") or YYYY-MM-DD ("2026-02-07")
  const dateArg = process.argv[2];

  // Fetch shows from Google Calendar
  const calData = await fetchShows(dateArg);
  const { day: dayName, month, dayNum, shows } = calData;

  if (shows.length === 0) {
    console.error(`No shows found for ${dayName} ${month} ${dayNum}. Check the calendar.`);
    process.exit(1);
  }

  const psdFile = DAY_MAP[dayName];
  if (!psdFile) throw new Error("No PSD template for: " + dayName);
  const psdPath = path.join(PSD_DIR, psdFile);

  const scheduleText = buildScheduleText(dayName, month, dayNum, shows);

  // --- Step A: Modify PSD text using ag-psd + @napi-rs/canvas ---

  // A1. Read PSD
  const psdBuffer = fs.readFileSync(psdPath);
  const psd = readPsd(psdBuffer);
  console.log("A1. PSD read");

  // A2. Find text layer
  const artboard = psd.children?.[0];
  const textLayer = findTextLayer(artboard.children || [], "SCHEDULE TEXT");
  if (!textLayer) throw new Error("Text layer not found");
  console.log("A2. Text layer found:", textLayer.text.text.substring(0, 40) + "...");

  // A2b. Align logo with text left margin
  const logoGroup = artboard.children?.find(l => l.name === "TLR LOGO");
  const textLeftEdge = (textLayer.left || 0) + 64; // text layer origin + xOffset
  if (logoGroup?.children) {
    for (const child of logoGroup.children) {
      const logoWidth = (child.right || 0) - (child.left || 0);
      child.left = textLeftEdge;
      child.right = textLeftEdge + logoWidth;
    }
    console.log("  Logo aligned to x=" + textLeftEdge);
  }

  // A2c. Move text layer up for more header space
  textLayer.top = (textLayer.top || 231) - 50;

  // A3. Update text descriptor
  textLayer.text.text = scheduleText;
  console.log("A3. Text descriptor updated");

  // A4. Render new text as bitmap with @napi-rs/canvas (Skia)
  const w = Math.max((textLayer.right || 0) - (textLayer.left || 0), 800);
  const h = Math.max((textLayer.bottom || 0) - (textLayer.top || 0), 1800);
  const textBitmap = skiaCanvas(w, h);
  const ctx = textBitmap.getContext("2d");
  ctx.fillStyle = "white";
  ctx.textBaseline = "top";
  const timeRegex = /^\d{1,2}:\d{2}\s+(AM|PM)\/ET$/;
  const lines = scheduleText.split("\r");
  const xOffset = 64;

  // Dynamic spacing — fixed inner gaps, pairGap flexes to fill available space
  const numShows = lines.filter(l => timeRegex.test(l)).length;
  const timeLead = 32;   // time → show name (fixed)
  const nameLead = 40;   // show name wrap / leading (fixed)
  const headerGap = 72;  // header → first show (fixed)

  // Estimate fixed vertical usage: header + per-show content
  const headerCost = 10 + 40 + nameLead + 40 + headerGap; // "TODAY" + dayline + gap
  const perShowCost = 30 + timeLead + 40 + nameLead;       // time line + name line
  const fixedUsage = headerCost + numShows * perShowCost;

  // Available space: text area top to logo zone (~1500px usable)
  const availableHeight = 1450;
  const pairSlots = Math.max(numShows - 1, 1);
  const pairGap = Math.max(36, Math.min(70, Math.round((availableHeight - fixedUsage) / pairSlots)));
  console.log(`  Spacing: ${numShows} shows, pairGap=${pairGap}, timeLead=${timeLead}, nameLead=${nameLead}`);

  let y = 10;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTime = timeRegex.test(line);
    const isEmpty = line.trim() === "";

    if (isTime) {
      ctx.font = "30px InputMono";
    } else {
      ctx.font = "40px InputMono";
    }

    if (!isEmpty) {
      const maxWidth = w - xOffset - 20;
      if (!isTime) {
        // Word-wrap loop: break into sub-lines until everything fits
        let remaining = line;
        let first = true;
        while (remaining.length > 0) {
          if (!first) y += nameLead;
          if (ctx.measureText(remaining).width <= maxWidth) {
            ctx.fillText(remaining, xOffset, y);
            break;
          }
          // Prefer " with " break on first split
          const withIdx = first ? remaining.indexOf(" with ") : -1;
          let breakIdx = -1;
          if (withIdx > 0 && ctx.measureText(remaining.substring(0, withIdx)).width <= maxWidth) {
            breakIdx = withIdx;
          } else {
            for (let s = remaining.length - 1; s > 0; s--) {
              if (remaining[s] === " " && ctx.measureText(remaining.substring(0, s)).width <= maxWidth) {
                breakIdx = s;
                break;
              }
            }
          }
          if (breakIdx > 0) {
            ctx.fillText(remaining.substring(0, breakIdx), xOffset, y);
            remaining = remaining.substring(breakIdx + 1);
          } else {
            ctx.fillText(remaining, xOffset, y); // can't break, force draw
            break;
          }
          first = false;
        }
      } else {
        ctx.fillText(line, xOffset, y);
      }
    }

    // Variable leading (dynamic)
    if (i === 1) {
      y += headerGap;
    } else if (isEmpty) {
      y += pairGap;
    } else if (isTime) {
      y += timeLead;
    } else {
      y += nameLead;
    }
  }
  textLayer.canvas = textBitmap;
  console.log("A4. Text bitmap rendered (" + w + "x" + h + "), textEndY=" + y);

  // A4b. Logo: keep at original position, only push down if text is too close
  const textAbsoluteBottom = (textLayer.top || 201) + y;
  const logoDefaultTop = 1700; // near bottom of 1920px image
  const logoMinGap = 50;
  const logoTargetTop = Math.max(logoDefaultTop, textAbsoluteBottom + logoMinGap);
  if (logoGroup?.children) {
    for (const child of logoGroup.children) {
      const logoHeight = (child.bottom || 0) - (child.top || 0);
      child.top = logoTargetTop;
      child.bottom = child.top + logoHeight;
    }
  }
  console.log(`  Logo: textBottom=${textAbsoluteBottom}, placed at top=${logoTargetTop}`);

  // A5. Write modified PSD
  const modifiedPsd = writePsd(psd);
  const tmpPath = path.join(OUTPUT_DIR, "_modified.psd");
  fs.writeFileSync(tmpPath, Buffer.from(modifiedPsd));
  console.log("A5. Modified PSD written");

  // --- Step B: Open in Photopea + export PNG ---

  // B1. Start Photopea
  const hp = new HeadlessPhotopea();
  await hp.isInitialized();
  console.log("B1. Photopea ready");

  // B2. Load font
  const fontBuf = fs.readFileSync(path.join(__dirname, "fonts", "InputMonoNarrow-Regular.ttf"));
  await hp.addBinaryAsset(fontBuf);
  console.log("B2. Font loaded");

  // B3. Open modified PSD
  const { server, port } = await servePSD(tmpPath);
  await hp.openFromURL(`http://127.0.0.1:${port}/file.psd`, false);
  console.log("B3. Modified PSD opened");

  // B4. Export PNG
  const pngResult = await hp.runScript('app.activeDocument.saveToOE("png");');
  let pngBuffer;
  for (const item of pngResult) {
    if (item instanceof ArrayBuffer || Buffer.isBuffer(item)) {
      pngBuffer = Buffer.from(item);
      break;
    }
    if (typeof item === "string" && item !== "done" && item.length > 100) {
      pngBuffer = Buffer.from(item, "base64");
      break;
    }
  }
  if (!pngBuffer) {
    console.error("PNG export failed. Result types:", pngResult.map(i => typeof i + ":" + String(i).length));
  }
  const outPath = path.join(OUTPUT_DIR, `TEST_${dayName}.png`);
  fs.writeFileSync(outPath, pngBuffer);
  console.log("B4. PNG exported:", outPath);

  await hp.destroy();
  server.close();
  fs.unlinkSync(tmpPath);

  // --- Step C: Post to Slack ---
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL) {
    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    await slack.filesUploadV2({
      channel_id: process.env.SLACK_CHANNEL,
      file: outPath,
      filename: `${dayName}_${month}_${dayNum}.png`,
      initial_comment: `Schedule for ${dayName} ${month} ${dayNum}`,
    });
    console.log("C. Posted to Slack");
  }
}

main().catch(e => console.error(e));

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

// Layout config
const LAYOUT = {
  timeFontSize: 24,
  nameFontSize: 34,
  timeLead: 34,       // time → show name gap
  nameLead: 32,       // show name wrap leading
  headerGap: 42,      // header → first show
  xOffset: 8,         // left margin for text
  minCanvasW: 800,
  minCanvasH: 1800,
  availableHeight: 1750,
  minPairGap: 50,
  maxPairGap: 65,
  logoDefaultTop: 1620,
  logoMinGap: 50,
  textTopAdjust: 20,  // pixels to move text layer up
};

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
  const textLeftEdge = (textLayer.left || 0) + LAYOUT.xOffset;
  if (logoGroup?.children) {
    for (const child of logoGroup.children) {
      const logoWidth = (child.right || 0) - (child.left || 0);
      child.left = textLeftEdge;
      child.right = textLeftEdge + logoWidth;
    }
    console.log("  Logo aligned to x=" + textLeftEdge);
  }

  // A2c. Move text layer up for more header space
  textLayer.top = (textLayer.top || 231) - LAYOUT.textTopAdjust;

  // A3. Update text descriptor
  textLayer.text.text = scheduleText;
  console.log("A3. Text descriptor updated");

  // A4. Render new text as bitmap with @napi-rs/canvas (Skia)
  const w = Math.max((textLayer.right || 0) - (textLayer.left || 0), LAYOUT.minCanvasW);
  const h = Math.max((textLayer.bottom || 0) - (textLayer.top || 0), LAYOUT.minCanvasH);
  const textBitmap = skiaCanvas(w, h);
  const ctx = textBitmap.getContext("2d");
  ctx.fillStyle = "white";
  ctx.textBaseline = "top";
  const timeRegex = /^\d{1,2}:\d{2}\s+(AM|PM)\/ET$/;
  const lines = scheduleText.split("\r");
  const { xOffset, timeLead, nameLead, headerGap, timeFontSize, nameFontSize } = LAYOUT;

  // Dynamic spacing — fixed inner gaps, pairGap flexes to fill available space
  const numShows = lines.filter(l => timeRegex.test(l)).length;

  // Estimate fixed vertical usage: header + per-show content
  const headerCost = 10 + nameFontSize + nameLead + nameFontSize + headerGap;
  const perShowCost = timeFontSize + timeLead + nameFontSize + nameLead;
  const fixedUsage = headerCost + numShows * perShowCost;

  const pairSlots = Math.max(numShows - 1, 1);
  const pairGap = Math.max(LAYOUT.minPairGap, Math.min(LAYOUT.maxPairGap, Math.round((LAYOUT.availableHeight - fixedUsage) / pairSlots)));
  console.log(`  Spacing: ${numShows} shows, pairGap=${pairGap}, timeLead=${timeLead}, nameLead=${nameLead}`);

  let y = 10;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTime = timeRegex.test(line);
    const isEmpty = line.trim() === "";

    if (isTime) {
      ctx.font = `${timeFontSize}px InputMono`;
    } else {
      ctx.font = `${nameFontSize}px InputMono`;
    }

    if (!isEmpty) {
      const maxWidth = w - xOffset - 20;
      if (!isTime) {
        // Force-split on " by " and " (" before wrapping
        let segments = [line];
        for (const sep of [" by ", " ("]) {
          const expanded = [];
          for (const seg of segments) {
            const idx = seg.indexOf(sep);
            if (idx > 0) {
              expanded.push(seg.substring(0, idx));
              const rest = sep.startsWith(" ") ? sep.trimStart() + seg.substring(idx + sep.length) : seg.substring(idx + sep.length);
              expanded.push(rest);
            } else {
              expanded.push(seg);
            }
          }
          segments = expanded;
        }
        // Word-wrap each segment, then overflow-wrap within if still too wide
        for (let si = 0; si < segments.length; si++) {
          let remaining = segments[si].trim();
          if (si > 0) y += nameLead;
          let first = si === 0;
          while (remaining.length > 0) {
            if (!first) y += nameLead;
            if (ctx.measureText(remaining).width <= maxWidth) {
              ctx.fillText(remaining, xOffset, y);
              break;
            }
            // Prefer semantic break on " with " on first split of first segment
            let breakIdx = -1;
            if (first) {
              const idx = remaining.indexOf(" with ");
              if (idx > 0 && ctx.measureText(remaining.substring(0, idx)).width <= maxWidth) {
                breakIdx = idx;
              }
            }
            if (breakIdx < 0) {
              for (let s = remaining.length - 1; s > 0; s--) {
                if (remaining[s] === " " && ctx.measureText(remaining.substring(0, s)).width <= maxWidth) {
                  breakIdx = s;
                  break;
                }
              }
            }
            if (breakIdx > 0) {
              ctx.fillText(remaining.substring(0, breakIdx).trimEnd(), xOffset, y);
              remaining = remaining.substring(breakIdx + 1).trimStart();
            } else {
              ctx.fillText(remaining, xOffset, y);
              break;
            }
            first = false;
          }
        }
      } else {
        ctx.fillText(line, xOffset, y);
      }
    }

    // Variable leading (dynamic)
    if (i === 0) {
      y += headerGap; // gap between "TODAY" and date line
    } else if (i === 1) {
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
  const logoTargetTop = Math.max(LAYOUT.logoDefaultTop, textAbsoluteBottom + LAYOUT.logoMinGap);
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
    await hp.destroy();
    server.close();
    fs.unlinkSync(tmpPath);
    throw new Error("PNG export failed. Result types: " + pngResult.map(i => typeof i + ":" + String(i).length));
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

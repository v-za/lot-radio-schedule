import HeadlessPhotopea from "headlessphotopea";
import { readPsd, writePsd, initializeCanvas } from "ag-psd";
import canvas from "canvas";
import { createCanvas as skiaCanvas, GlobalFonts } from "@napi-rs/canvas";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

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
  const dayArg = process.argv[2] || "Saturday";
  const psdFile = DAY_MAP[dayArg];
  if (!psdFile) throw new Error("Unknown day: " + dayArg + ". Use: " + Object.keys(DAY_MAP).join(", "));
  const psdPath = path.join(PSD_DIR, psdFile);

  const showSets = {
    "8_SHOWS": [
      { time: "10:00 AM/ET", name: "Love Injection" },
      { time: "12:00 PM/ET", name: "Darker Than Wax FM with mvns" },
      { time: "2:00 PM/ET", name: "Ransom Note" },
      { time: "5:00 PM/ET", name: "Tranquilamente Radio with Yibing" },
      { time: "6:00 PM/ET", name: "CRYSTALLMESS" },
      { time: "7:00 PM/ET", name: "Woody92" },
      { time: "8:00 PM/ET", name: "D'Julz" },
      { time: "9:00 PM/ET", name: "Twist 4 Year with Don-Ri and Eva Loveless" },
    ],
    "6_SHOWS": [
      { time: "10:00 AM/ET", name: "Love Injection" },
      { time: "12:00 PM/ET", name: "Darker Than Wax FM with mvns" },
      { time: "2:00 PM/ET", name: "Ransom Note" },
      { time: "5:00 PM/ET", name: "CRYSTALLMESS" },
      { time: "7:00 PM/ET", name: "Woody92" },
      { time: "9:00 PM/ET", name: "Twist 4 Year with Don-Ri and Eva Loveless" },
    ],
    "7_SHOWS": [
      { time: "10:00 AM/ET", name: "Love Injection" },
      { time: "12:00 PM/ET", name: "Darker Than Wax FM with mvns" },
      { time: "2:00 PM/ET", name: "Ransom Note" },
      { time: "5:00 PM/ET", name: "Tranquilamente Radio with Yibing" },
      { time: "6:00 PM/ET", name: "CRYSTALLMESS" },
      { time: "7:00 PM/ET", name: "Woody92" },
      { time: "9:00 PM/ET", name: "Twist 4 Year with Don-Ri and Eva Loveless" },
    ],
    "STRESS_TEST": [
      { time: "10:00 AM/ET", name: "DJ A" },                                          // short
      { time: "11:00 AM/ET", name: "Tranquilamente Radio with Yibing" },               // long with "with", overflows
      { time: "12:00 PM/ET", name: "The Incredibly Long Show Name That Has No With" }, // long, no "with"
      { time: "2:00 PM/ET", name: "Chill with Max" },                                 // short with "with", fits on one line
      { time: "4:00 PM/ET", name: "Deep Cuts Presented By The Underground Collective" }, // long, no "with"
      { time: "6:00 PM/ET", name: "Twist 4 Year with Don-Ri and Eva Loveless" },      // long with "with"
      { time: "8:00 PM/ET", name: "CRYSTALLMESS" },                                   // medium
      { time: "9:00 PM/ET", name: "Late Night Sessions with DJ Haze and Friends Forever and The Whole Entire Crew" }, // 3-line wrap test
    ],
    "12_SHOWS": [
      { time: "8:00 AM/ET", name: "Morning Ritual" },
      { time: "9:00 AM/ET", name: "Sunrise Sessions" },
      { time: "10:00 AM/ET", name: "Love Injection" },
      { time: "11:00 AM/ET", name: "Skyline Sessions with DJ Haze" },
      { time: "12:00 PM/ET", name: "Darker Than Wax FM with mvns" },
      { time: "1:00 PM/ET", name: "Deep Cuts" },
      { time: "2:00 PM/ET", name: "Ransom Note" },
      { time: "4:00 PM/ET", name: "Golden Hour Radio" },
      { time: "5:00 PM/ET", name: "Tranquilamente Radio with Yibing" },
      { time: "6:00 PM/ET", name: "CRYSTALLMESS" },
      { time: "7:00 PM/ET", name: "Woody92" },
      { time: "9:00 PM/ET", name: "Twist 4 Year with Don-Ri and Eva Loveless" },
    ],
  };

  const shows = showSets["8_SHOWS"]; // OG set list for now
  const scheduleText = buildScheduleText(dayArg, "January", 24, shows);

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

  // A2b. Shift logo layer to match new text margin
  const logoGroup = artboard.children?.find(l => l.name === "TLR LOGO");
  if (logoGroup?.children) {
    for (const child of logoGroup.children) {
      child.left += 48;
      child.right += 48;
    }
  }

  // A2c. Move text layer up for more header space
  textLayer.top = (textLayer.top || 231) - 30;

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
  const xOffset = 48;

  // Spacing — gentle bump for fewer shows
  const numShows = lines.filter(l => timeRegex.test(l)).length;
  const sparseBoost = numShows < 8 ? 1 + (8 - numShows) * 0.06 : 1; // e.g. 6 shows = 1.12x, 7 = 1.06x
  const headerGap = Math.round(80 * sparseBoost);
  const pairGap = Math.round(30 * sparseBoost);
  const timeLead = Math.round(34 * sparseBoost);
  const nameLead = Math.round(44 * sparseBoost);
  console.log(`  Spacing: ${numShows} shows, boost=${sparseBoost.toFixed(2)}`);

  let y = 10;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTime = timeRegex.test(line);
    const isEmpty = line.trim() === "";

    if (isTime) {
      ctx.font = "28px InputMono";
    } else {
      ctx.font = "38px InputMono";
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
  const outPath = path.join(OUTPUT_DIR, `TEST_${dayArg}.png`);
  fs.writeFileSync(outPath, pngBuffer);
  console.log("B4. PNG exported:", outPath);

  await hp.destroy();
  server.close();
  fs.unlinkSync(tmpPath);
}

main().catch(e => console.error(e));

import ical from "node-ical";

const TZ = "America/New_York";

// Format a JS Date in ET as "10:00 AM/ET"
function formatTimeET(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const hour = parts.find((p) => p.type === "hour").value;
  const minute = parts.find((p) => p.type === "minute").value;
  const period = parts.find((p) => p.type === "dayPeriod").value;
  return `${hour}:${minute}  ${period}/ET`;
}

// Get YYYY-MM-DD string for a Date in ET
function toETDateString(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

// Get day name, month name, day number from a Date in ET
function getETDateInfo(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const parts = fmt.formatToParts(date);
  return {
    day: parts.find((p) => p.type === "weekday").value,
    month: parts.find((p) => p.type === "month").value,
    dayNum: parts.find((p) => p.type === "day").value,
    year: parts.find((p) => p.type === "year").value,
  };
}

// Strip emoji prefixes (e.g. "🔃Show Name" → "Show Name")
// Returns empty string for restream events (filtered out)
function cleanSummary(summary) {
  if (!summary) return "";
  if (/restream/i.test(summary)) return "";
  return summary.replace(/^[\p{Emoji}\p{Emoji_Component}\s]+/u, "").trim();
}

// Resolve a day name ("Saturday") to the next occurrence as YYYY-MM-DD
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function resolveDayName(name) {
  const idx = DAYS.indexOf(name);
  if (idx === -1) return null;
  const now = new Date();
  const today = now.getDay();
  const diff = (idx - today + 7) % 7;
  const target = new Date(now);
  target.setDate(target.getDate() + (diff === 0 ? 0 : diff));
  return toETDateString(target);
}

/**
 * Fetch shows from Google Calendar iCal feed.
 * @param {string} [dateArg] - Optional: YYYY-MM-DD date, day name ("Saturday"), or omit for today.
 * @returns {Promise<{ day: string, month: string, dayNum: string, year: string, shows: Array<{ time: string, name: string }> }>}
 */
export async function fetchShows(dateArg) {
  const url = process.env.ICAL_URL;
  if (!url) throw new Error("ICAL_URL not set in .env");

  // Determine target date in ET
  let targetDate;
  if (!dateArg) {
    targetDate = toETDateString(new Date());
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    targetDate = dateArg;
  } else {
    targetDate = resolveDayName(dateArg);
    if (!targetDate) throw new Error("Invalid date: " + dateArg + ". Use YYYY-MM-DD or day name.");
  }

  console.log(`Fetching calendar for ${targetDate}...`);
  const data = await ical.async.fromURL(url);

  // UTC bounds for RRULE expansion — widen to cover full ET day
  // ET is UTC-5 (EST) or UTC-4 (EDT), so a show at 11 PM ET could be 04:00 UTC next day
  const rruleAfter = new Date(targetDate + "T04:00:00Z");  // midnight ET (EST) = 5AM UTC, use 4AM for safety
  const nextDay = new Date(rruleAfter);
  nextDay.setDate(nextDay.getDate() + 1);
  const rruleBefore = new Date(nextDay.toISOString().slice(0, 10) + "T05:59:59Z"); // ~1AM ET next day

  const shows = [];
  const seen = new Set(); // dedupe by time+name

  for (const event of Object.values(data)) {
    if (event.type !== "VEVENT") continue;

    try {
      if (event.rrule) {
        // Recurring event — expand RRULE to find occurrences on target date
        let occurrences;
        try {
          occurrences = event.rrule.between(rruleAfter, rruleBefore, true);
        } catch { continue; }

        for (const occ of occurrences) {
          let summary = event.summary;
          let startTime = occ;

          // Check for recurrence override (modified instance)
          if (event.recurrences) {
            const override =
              event.recurrences[targetDate] ||
              event.recurrences[occ.toISOString()];
            if (override) {
              summary = override.summary || summary;
              startTime = override.start || startTime;
            }
          }

          // Check exdate (excluded dates)
          if (event.exdate) {
            const excluded = Object.values(event.exdate).some((d) => {
              try { return toETDateString(d) === targetDate; } catch { return false; }
            });
            if (excluded) continue;
          }

          // Verify the occurrence falls on target date in ET
          try {
            if (toETDateString(startTime) !== targetDate) continue;
          } catch { continue; }

          const name = cleanSummary(summary);
          if (!name) continue;
          const key = formatTimeET(startTime) + "|" + name;
          if (seen.has(key)) continue;
          seen.add(key);

          shows.push({
            time: formatTimeET(startTime),
            name,
            _sort: startTime.getTime(),
          });
        }
        // Also check recurrence overrides that MOVE events onto the target date
        // (e.g., a weekly show rescheduled from Jan 17 to Jan 24)
        if (event.recurrences) {
          for (const override of Object.values(event.recurrences)) {
            if (!override.start) continue;
            try {
              if (toETDateString(override.start) !== targetDate) continue;
            } catch { continue; }

            const name = cleanSummary(override.summary || event.summary);
            if (!name) continue;
            const key = formatTimeET(override.start) + "|" + name;
            if (seen.has(key)) continue;
            seen.add(key);

            shows.push({
              time: formatTimeET(override.start),
              name,
              _sort: override.start.getTime(),
            });
          }
        }
      } else if (event.start) {
        // One-off event — check if it falls on target date in ET
        if (toETDateString(event.start) !== targetDate) continue;

        const name = cleanSummary(event.summary);
        if (!name) continue;
        const key = formatTimeET(event.start) + "|" + name;
        if (seen.has(key)) continue;
        seen.add(key);

        shows.push({
          time: formatTimeET(event.start),
          name,
          _sort: event.start.getTime(),
        });
      }
    } catch {
      // Skip events with bad data
      continue;
    }
  }

  shows.sort((a, b) => a._sort - b._sort);
  shows.forEach((s) => delete s._sort);

  // Get date info from target date (use noon ET to avoid DST edge cases)
  const [y, m, d] = targetDate.split("-");
  const target = new Date(`${y}-${m}-${d}T12:00:00`);
  const info = getETDateInfo(target);

  console.log(`Found ${shows.length} shows for ${info.day} ${info.month} ${info.dayNum}`);
  return { ...info, shows };
}

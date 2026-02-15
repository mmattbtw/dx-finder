import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const LOCATION_BASE_URL = "https://location.am-all.net/alm/location";
const LOCATION_GM = "98";
const LOCATION_LANG = "en";
const STATE_FILE = process.env.STATE_FILE ?? "state/closest-cabinet.json";
const RAW_INTERVAL_MINUTES = Number.parseInt(process.env.CHECK_INTERVAL_MINUTES ?? "60", 10);
const CHECK_INTERVAL_MINUTES = Number.isFinite(RAW_INTERVAL_MINUTES) && RAW_INTERVAL_MINUTES > 0
  ? RAW_INTERVAL_MINUTES
  : 60;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;

const DEFAULT_LOCATION = {
  lat: 36.1627,
  lon: -86.7816,
  label: "Nashville, TN",
};

type CabinetLocation = {
  id: string;
  name: string;
  address: string;
  distanceKm: number;
  detailsUrl: string;
  sourceUrl: string;
  distanceMiles: number;
};

type ClosestState = {
  checkedAt: string;
  closest: CabinetLocation;
};

type TargetLocation = {
  lat: number;
  lon: number;
  label: string;
};

function htmlDecode(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#160;", " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .trim();
}

function parseDistanceKm(value: string): number | null {
  const match = value.match(/(\d+(?:\.\d+)?)\s*km/i);
  const kmRaw = match?.[1];
  if (!kmRaw) {
    return null;
  }
  const distanceKm = Number.parseFloat(kmRaw);
  return Number.isFinite(distanceKm) ? distanceKm : null;
}

async function scrapeLocations(sourceUrl: string): Promise<CabinetLocation[]> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source page: HTTP ${response.status}`);
  }

  const html = await response.text();
  const liBlocks = html.match(/<li>[\s\S]*?<\/li>/g) ?? [];

  const locations: CabinetLocation[] = [];

  for (const li of liBlocks) {
    const nameMatch = li.match(/class="store_name">([\s\S]*?)<\/span>/);
    const name = nameMatch?.[1] ? htmlDecode(nameMatch[1]) : null;
    const addressLines = Array.from(li.matchAll(/class="store_address">([\s\S]*?)<\/span>/g))
      .map((match) => htmlDecode(match[1] ?? ""));
    const detailsMatch = li.match(/class="bt_details_en"[^>]*onclick="([^"]+)"/);
    const detailsOnclick = detailsMatch?.[1] ? htmlDecode(detailsMatch[1]) : null;
    const distanceKm = addressLines.map(parseDistanceKm).find((value) => value !== null) ?? null;
    const address = addressLines.find((line) => parseDistanceKm(line) === null) ?? null;

    if (!name || !address || !detailsOnclick || distanceKm === null) {
      continue;
    }

    const cabinetId = detailsOnclick.match(/sid=(\d+)/)?.[1] ?? null;

    if (!cabinetId) {
      continue;
    }

    const detailsUrl = `https://location.am-all.net/alm/shop?gm=98&astep=-1&sid=${cabinetId}&lang=en`;

    locations.push({
      id: cabinetId,
      name,
      address,
      distanceKm,
      detailsUrl,
      sourceUrl,
      distanceMiles: distanceKm * 0.621371,
    });
  }

  if (locations.length === 0) {
    throw new Error("No cabinet locations parsed from the source page");
  }

  return locations;
}

async function runCheckOnce(targetLocation: TargetLocation): Promise<void> {
  const sourceUrl = `${LOCATION_BASE_URL}?${new URLSearchParams({
    gm: LOCATION_GM,
    lat: targetLocation.lat.toString(),
    lng: targetLocation.lon.toString(),
    lang: LOCATION_LANG,
  }).toString()}`;
  const locations = await scrapeLocations(sourceUrl);
  const [closest] = locations;
  if (!closest) {
    throw new Error("No cabinet locations parsed from the source page");
  }

  const stateFile = Bun.file(STATE_FILE);
  const previous = await stateFile.exists() ? await stateFile.json() as ClosestState : null;
  const checkedAt = new Date().toISOString();
  const currentState: ClosestState = { checkedAt, closest };

  await mkdir(dirname(STATE_FILE), { recursive: true });
  await Bun.write(STATE_FILE, `${JSON.stringify(currentState, null, 2)}\n`);

  console.log(`Parsed ${locations.length} cabinets from source.`);
  console.log(
    `Current closest to ${targetLocation.label}: ${closest.name} [sid=${closest.id}] - ${closest.address} (${closest.distanceMiles.toFixed(1)} mi)`,
  );

  if (!previous) {
    console.log(`No previous state found at ${STATE_FILE}; initialized state without notifying.`);
    return;
  }

  if (previous.closest.id === closest.id) {
    console.log("Closest cabinet unchanged. No webhook sent.");
    return;
  }

  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("Closest cabinet changed, but WEBHOOK_URL is not set. Skipping webhook.");
    return;
  }

  const prev = previous.closest;
  const next = closest;
  const webhookBody = {
    username: "DX Finder",
    content: `Closest maimai DX cabinet changed for **${targetLocation.label}**.`,
    embeds: [
      {
        title: "Closest Cabinet Updated",
        url: sourceUrl,
        color: 15277667,
        timestamp: checkedAt,
        fields: [
          {
            name: "Previous",
            value:
              `**${prev.name}** (sid: \`${prev.id}\`)\n` +
              `${prev.address}\n` +
              `${prev.distanceMiles.toFixed(1)} mi from ${targetLocation.label}\n` +
              `[Details](${prev.detailsUrl})`,
          },
          {
            name: "New",
            value:
              `**${next.name}** (sid: \`${next.id}\`)\n` +
              `${next.address}\n` +
              `${next.distanceMiles.toFixed(1)} mi from ${targetLocation.label}\n` +
              `[Details](${next.detailsUrl})`,
          },
        ],
        footer: {
          text: "maimai DX location monitor",
        },
      },
    ],
    allowed_mentions: {
      parse: [],
    },
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(webhookBody),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webhook failed: HTTP ${response.status} ${body}`);
  }

  console.log(
    `Closest cabinet changed: ${previous.closest.id} -> ${closest.id}. Webhook notification attempted.`,
  );
}

async function main(): Promise<void> {
  const latRaw = process.env.TARGET_LAT;
  const lonRaw = process.env.TARGET_LON;
  const label = process.env.TARGET_LABEL?.trim() || DEFAULT_LOCATION.label;
  let targetLocation: TargetLocation = DEFAULT_LOCATION;

  if (latRaw || lonRaw) {
    if (!latRaw || !lonRaw) {
      throw new Error("Both TARGET_LAT and TARGET_LON must be set together.");
    }
    const lat = Number.parseFloat(latRaw);
    const lon = Number.parseFloat(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("TARGET_LAT and TARGET_LON must be valid numbers.");
    }
    targetLocation = { lat, lon, label };
  }

  let stopRequested = false;
  const handleStop = () => {
    stopRequested = true;
    console.log("Stop signal received. Exiting after current cycle.");
  };
  process.on("SIGINT", handleStop);
  process.on("SIGTERM", handleStop);

  console.log(`Starting monitor loop. Checking every ${CHECK_INTERVAL_MINUTES} minute(s).`);
  console.log(`Target location: ${targetLocation.label} (${targetLocation.lat}, ${targetLocation.lon})`);

  while (!stopRequested) {
    const startedAt = Date.now();
    try {
      await runCheckOnce(targetLocation);
    } catch (error) {
      console.error("Check cycle failed:", error);
    }

    if (stopRequested) {
      break;
    }

    const elapsed = Date.now() - startedAt;
    let remaining = Math.max(0, CHECK_INTERVAL_MS - elapsed);
    console.log(`Next check in ${(remaining / 1000).toFixed(0)}s.`);
    while (remaining > 0 && !stopRequested) {
      const sleepMs = Math.min(1000, remaining);
      await Bun.sleep(sleepMs);
      remaining -= sleepMs;
    }
  }
}

main().catch((error) => {
  console.error("Monitor failed:", error);
  process.exit(1);
});

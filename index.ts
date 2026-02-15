import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SOURCE_URL = "https://location.am-all.net/alm/location?gm=98&lang=en&ct=1009";
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
  lat: number;
  lon: number;
  detailsUrl: string;
  sourceUrl: string;
  distanceMiles: number;
};

type ClosestState = {
  checkedAt: string;
  closest: CabinetLocation;
};

type ChangeEventPayload = {
  event: "closest_cabinet_changed";
  checkedAt: string;
  city: string;
  previousClosest: CabinetLocation;
  newClosest: CabinetLocation;
  sourceUrl: string;
};

type TargetLocation = {
  lat: number;
  lon: number;
  label: string;
};

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;

  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function htmlDecode(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .trim();
}

function extractFirst(source: string, regex: RegExp): string | null {
  const match = source.match(regex);
  const value = match?.[1];
  return value ? htmlDecode(value) : null;
}

function parseCoordinates(onclick: string): { lat: number; lon: number } | null {
  const match = onclick.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:&|')/);
  const latRaw = match?.[1];
  const lonRaw = match?.[2];

  if (!latRaw || !lonRaw) {
    return null;
  }

  const lat = Number.parseFloat(latRaw);
  const lon = Number.parseFloat(lonRaw);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return { lat, lon };
}

function parseCabinetId(onclick: string): string | null {
  const sidMatch = onclick.match(/sid=(\d+)/);
  const sid = sidMatch?.[1];
  return sid ?? null;
}

async function scrapeLocations(): Promise<CabinetLocation[]> {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch source page: HTTP ${response.status}`);
  }

  const html = await response.text();
  const liBlocks = html.match(/<li>[\s\S]*?<\/li>/g) ?? [];

  const locations: CabinetLocation[] = [];

  for (const li of liBlocks) {
    const name = extractFirst(li, /class="store_name">([\s\S]*?)<\/span>/);
    const address = extractFirst(li, /class="store_address">([\s\S]*?)<\/span>/);
    const mapOnclick = extractFirst(li, /class="store_bt_google_map_en"[^>]*onclick="([^"]+)"/);
    const detailsOnclick = extractFirst(li, /class="bt_details_en"[^>]*onclick="([^"]+)"/);

    if (!name || !address || !mapOnclick || !detailsOnclick) {
      continue;
    }

    const coordinates = parseCoordinates(mapOnclick);
    const cabinetId = parseCabinetId(detailsOnclick);

    if (!coordinates || !cabinetId) {
      continue;
    }

    const detailsUrl = `https://location.am-all.net/alm/shop?gm=98&astep=1009&sid=${cabinetId}&lang=en`;

    locations.push({
      id: cabinetId,
      name,
      address,
      lat: coordinates.lat,
      lon: coordinates.lon,
      detailsUrl,
      sourceUrl: SOURCE_URL,
      distanceMiles: 0,
    });
  }

  if (locations.length === 0) {
    throw new Error("No cabinet locations parsed from the source page");
  }

  return locations;
}

function getTargetLocation(): TargetLocation {
  const latRaw = process.env.TARGET_LAT;
  const lonRaw = process.env.TARGET_LON;
  const label = process.env.TARGET_LABEL?.trim() || DEFAULT_LOCATION.label;

  if (!latRaw && !lonRaw) {
    return DEFAULT_LOCATION;
  }

  if (!latRaw || !lonRaw) {
    throw new Error("Both TARGET_LAT and TARGET_LON must be set together.");
  }

  const lat = Number.parseFloat(latRaw);
  const lon = Number.parseFloat(lonRaw);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("TARGET_LAT and TARGET_LON must be valid numbers.");
  }

  return { lat, lon, label };
}

async function readState(path: string): Promise<ClosestState | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }

  const data = await file.json();
  return data as ClosestState;
}

async function writeState(path: string, state: ClosestState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
}

function buildDiscordWebhookBody(payload: ChangeEventPayload): Record<string, unknown> {
  const prev = payload.previousClosest;
  const next = payload.newClosest;

  return {
    username: "DX Finder",
    content: `Closest maimai DX cabinet changed for **${payload.city}**.`,
    embeds: [
      {
        title: "Closest Cabinet Updated",
        url: payload.sourceUrl,
        color: 15277667,
        timestamp: payload.checkedAt,
        fields: [
          {
            name: "Previous",
            value:
              `**${prev.name}** (sid: \`${prev.id}\`)\n` +
              `${prev.address}\n` +
              `${prev.distanceMiles.toFixed(1)} mi from ${payload.city}\n` +
              `[Details](${prev.detailsUrl})`,
          },
          {
            name: "New",
            value:
              `**${next.name}** (sid: \`${next.id}\`)\n` +
              `${next.address}\n` +
              `${next.distanceMiles.toFixed(1)} mi from ${payload.city}\n` +
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
}

async function notifyWebhook(payload: ChangeEventPayload): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("Closest cabinet changed, but WEBHOOK_URL is not set. Skipping webhook.");
    return;
  }

  const body = buildDiscordWebhookBody(payload);
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webhook failed: HTTP ${response.status} ${body}`);
  }
}

function formatLocation(location: CabinetLocation): string {
  return `${location.name} [sid=${location.id}] - ${location.address} (${location.distanceMiles.toFixed(1)} mi)`;
}

async function runCheckOnce(targetLocation: TargetLocation): Promise<void> {
  const locations = await scrapeLocations();
  const withDistance = locations.map((location) => ({
    ...location,
    distanceMiles: haversineMiles(targetLocation.lat, targetLocation.lon, location.lat, location.lon),
  }));
  const closest = withDistance.reduce((best, current) =>
    current.distanceMiles < best.distanceMiles ? current : best,
  );

  const previous = await readState(STATE_FILE);
  const checkedAt = new Date().toISOString();
  const currentState: ClosestState = { checkedAt, closest };

  await writeState(STATE_FILE, currentState);

  console.log(`Parsed ${withDistance.length} cabinets from source.`);
  console.log(`Current closest to ${targetLocation.label}: ${formatLocation(closest)}`);

  if (!previous) {
    console.log(`No previous state found at ${STATE_FILE}; initialized state without notifying.`);
    return;
  }

  if (previous.closest.id === closest.id) {
    console.log("Closest cabinet unchanged. No webhook sent.");
    return;
  }

  const payload: ChangeEventPayload = {
    event: "closest_cabinet_changed",
    checkedAt,
    city: targetLocation.label,
    previousClosest: previous.closest,
    newClosest: closest,
    sourceUrl: SOURCE_URL,
  };

  await notifyWebhook(payload);
  console.log(
    `Closest cabinet changed: ${previous.closest.id} -> ${closest.id}. Webhook notification attempted.`,
  );
}

function setupSignalHandlers(): { shouldStop: () => boolean } {
  let stopRequested = false;
  const handleStop = () => {
    stopRequested = true;
    console.log("Stop signal received. Exiting after current cycle.");
  };
  process.on("SIGINT", handleStop);
  process.on("SIGTERM", handleStop);
  return { shouldStop: () => stopRequested };
}

async function sleepUntilNextCycle(waitMs: number, shouldStop: () => boolean): Promise<void> {
  const stepMs = 1000;
  let remaining = waitMs;

  while (remaining > 0 && !shouldStop()) {
    const sleepMs = Math.min(stepMs, remaining);
    await Bun.sleep(sleepMs);
    remaining -= sleepMs;
  }
}

async function main(): Promise<void> {
  const targetLocation = getTargetLocation();
  const { shouldStop } = setupSignalHandlers();
  console.log(`Starting monitor loop. Checking every ${CHECK_INTERVAL_MINUTES} minute(s).`);
  console.log(`Target location: ${targetLocation.label} (${targetLocation.lat}, ${targetLocation.lon})`);

  while (!shouldStop()) {
    const startedAt = Date.now();
    try {
      await runCheckOnce(targetLocation);
    } catch (error) {
      console.error("Check cycle failed:", error);
    }

    if (shouldStop()) {
      break;
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(0, CHECK_INTERVAL_MS - elapsed);
    console.log(`Next check in ${(waitMs / 1000).toFixed(0)}s.`);
    await sleepUntilNextCycle(waitMs, shouldStop);
  }
}

main().catch((error) => {
  console.error("Monitor failed:", error);
  process.exit(1);
});

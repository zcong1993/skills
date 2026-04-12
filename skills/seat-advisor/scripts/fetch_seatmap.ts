#!/usr/bin/env bun
/* eslint-disable */
declare const process: { argv: string[]; exit(code?: number): never };
/**
 * fetch_seatmap.ts
 *
 * 模式 1：查询航班列表
 *   bun fetch_seatmap.ts flights <from> <to> <date> [airline]
 *   示例: bun fetch_seatmap.ts flights HKG SYD 2026-04-03
 *   返回: 航班列表 JSON（不含座位图，速度快）
 *
 * 模式 2：查询单个座位图
 *   bun fetch_seatmap.ts seatmap <planeId> <aircraftName>
 *   示例: bun fetch_seatmap.ts seatmap ac0b236e346da355400a90fcc7e28be6 "A330-300 V.1"
 *   返回: 完整座位图 JSON
 */

// ── Cookie（写死）────────────────────────────────────────────────────────────
const COOKIE = "e6157ae9-96f9-470b-b817-6cf860bda82f";

const [, , mode, ...args] = process.argv;

if (mode !== "flights" && mode !== "seatmap") {
  console.error("用法: bun fetch_seatmap.ts flights <from> <to> <date> [airline]");
  console.error("      bun fetch_seatmap.ts seatmap <planeId> <aircraftName>");
  process.exit(1);
}

const HEADERS = {
  accept: "*/*",
  "accept-language": "zh-CN,zh;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  referer: "https://seatmaps.com/",
};

// ── Step 1: 获取 JWT ──────────────────────────────────────────────────────────
async function getToken(): Promise<string> {
  const res = await fetch("https://seatmaps.com/auth", {
    headers: { ...HEADERS, cookie: `cookie=${COOKIE}` },
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Cookie 已过期。请访问 https://seatmaps.com，打开 DevTools → Application → Cookies，复制 'cookie' 的值，更新 fetch_seatmap.ts 中的 COOKIE 常量。");
    }
    throw new Error(`获取 token 失败: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { accessToken: string };
  if (!json.accessToken) throw new Error("获取 token 失败: 响应中无 accessToken");
  return json.accessToken;
}

// ── Step 2: 查询航班列表 ───────────────────────────────────────────────────────
interface Flight {
  airlineCode: string;
  flightNo: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  travelTime: string;
  planeId: string;
}

interface Aircraft {
  code: string;
  name: string;
  planeId: string;
  mobileLink: string;
}

interface Airline {
  code: string;
  name: string;
}

interface Direction {
  departure: string;
  arrival: string;
  flights: Flight[];
}

interface Route {
  directions: Direction[];
  aircrafts: Aircraft[];
  airlines: Airline[];
}

async function queryFlights(token: string, from: string, to: string, date: string, airline = "--"): Promise<Route[]> {
  const url = `https://api.seatmaps.com/api/v1/schedule/find/${airline}/${from}/${to}/${date}?returnDate=undefined&lang=ZH-CN`;
  const res = await fetch(url, {
    headers: {
      ...HEADERS,
      authorization: `Bearer ${token}`,
      origin: "https://seatmaps.com",
      "sec-fetch-site": "same-site",
    },
  });
  if (!res.ok) {
    throw new Error(`查询航班失败: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { routes: Route[] };
  return json.routes ?? [];
}

// ── Step 3: 解析座位图 HTML ───────────────────────────────────────────────────
interface SeatFeature {
  name: string;
  value: string; // "+" 好特性 | "-" 差特性
}

// Feature bitmask — bad features < 256, good features >= 256
const F = {
  nearGalley:         0x001,
  nearLavatory:       0x002,
  limitedRecline:     0x004,
  noFloorStorage:     0x008,
  getColdByExit:      0x010,
  wingInWindow:       0x020,
  misalignedWindow:   0x040,
  trayTableInArmrest: 0x080,
  extraLegroom:       0x100,
  exitRow:            0x200,
  standardSeat:       0x400,
  bassinet:           0x800,
} as const;

interface CabinInfo {
  code: string;
  label: string;
  rowStart: number;
  rowEnd: number;
  seatCount: number;
  layout: string; // e.g. "3-4-3"
  columns: string[]; // e.g. ["A","B","C","D","E","F","G","H","J","K"]
  windowCols: string[];
  aisleCols: string[];
}

interface ClassFeatures {
  wifi_enabled?: string;
  [cls: string]: { seat_pitch?: string; seat_width?: string; seat_recline?: string; audio_video_ondemand?: string; usbPowerPlug?: string } | string | undefined;
}

// 优化后的座位数据：默认 feature + 例外列表
interface SeatExceptions {
  [featureValue: string]: string[]; // feature bitmask → 座位号列表
}

interface SeatmapData {
  planeId: string;
  aircraftName: string;
  classFeatures: ClassFeatures;
  cabins: CabinInfo[];
  defaultFeature: number;       // 大多数座位的 feature 值（通常是 standardSeat=1024）
  seatExceptions: SeatExceptions; // 非默认 feature 的座位，按 feature 值分组
  wingRows: number[];
  F: typeof F;
}

function parseSeatmapHtml(html: string, planeId: string, aircraftName: string): SeatmapData {
  // 舱级特性
  const cfMatch = html.match(/data-seat-class-features="([^"]+)"/);
  const classFeatures: ClassFeatures = cfMatch
    ? JSON.parse(cfMatch[1].replace(/&quot;/g, '"'))
    : {};

  // 所有座位元素
  const seatDivRegex = /data-number="([^"]+)"[^>]+data-class="([^"]+)"[^>]+data-label="([^"]+)"[^>]+data-features="([^"]*)"[^>]+data-row-number="(\d+)"/g;

  // 同时收集横向位置，用于判断 window/aisle
  // margin-left 可能是 "Npx" 或 "0"（无单位），两种都要匹配
  const posRegex = /class="absolute comp-plane_seat[^"]*"[^>]+style="[^"]*margin-left:(-?\d+)(?:px)?[;"][^>]+data-number="([^"]+)"/g;
  const seatPositions: Record<string, number> = {};
  let pm: RegExpExecArray | null;
  while ((pm = posRegex.exec(html)) !== null) {
    seatPositions[pm[2]] = parseInt(pm[1]);
  }

  const rawSeats: Array<{
    number: string; row: number; col: string; cls: string; label: string; features: SeatFeature[];
  }> = [];

  let m: RegExpExecArray | null;
  while ((m = seatDivRegex.exec(html)) !== null) {
    const [, number, cls, label, featRaw, rowStr] = m;
    const features: SeatFeature[] = featRaw
      ? JSON.parse(featRaw.replace(/&quot;/g, '"'))
      : [];
    const col = number.replace(/\d+/g, "");
    rawSeats.push({ number, row: parseInt(rowStr), col, cls, label, features });
  }

  // 按舱等分组，推断列布局
  const cabinMap: Record<string, typeof rawSeats> = {};
  for (const s of rawSeats) {
    (cabinMap[s.cls] ??= []).push(s);
  }

  const cabins: CabinInfo[] = [];
  for (const [cls, seats] of Object.entries(cabinMap)) {
    const rows = [...new Set(seats.map((s) => s.row))].sort((a, b) => a - b);

    // 找座位最多的那排作为布局参考（交错式商务舱奇偶排列不同，用最多座的排避免列混合）
    const rowColMap: Record<number, string[]> = {};
    for (const s of seats) {
      (rowColMap[s.row] ??= []).push(s.col);
    }
    const refRow = rows.reduce((best, r) =>
      (rowColMap[r].length > rowColMap[best].length ? r : best), rows[0]);
    const refCols = rowColMap[refRow];

    // 只取参考排的列，按横向位置排序
    const getPos = (col: string): number => {
      const p = seatPositions[`${refRow}${col}`];
      if (p !== undefined && !isNaN(p)) return p;
      // fallback: 跨排查找（处理 margin-left:0 等边缘情况）
      for (const r of rows) {
        const q = seatPositions[`${r}${col}`];
        if (q !== undefined && !isNaN(q)) return q;
      }
      return 0;
    };

    const cols = [...new Set(refCols)].sort((a, b) => getPos(a) - getPos(b));
    const sortedCols = [...cols].sort((a, b) => getPos(a) - getPos(b));

    // 最左和最右的列为窗口
    const windowCols = [sortedCols[0], sortedCols[sortedCols.length - 1]].filter(
      (c, i, a) => a.indexOf(c) === i
    );

    // 推断 layout：按位置计算相邻间距，通道处间距明显更大
    const colPositions = sortedCols.map((c) => getPos(c));
    const gaps: number[] = [];
    for (let i = 1; i < colPositions.length; i++) {
      gaps.push(colPositions[i] - colPositions[i - 1]);
    }
    // 用最小间距作为基准：避免 1-2-1 走廊式布局中中位数落在通道间距上导致检测失效
    const minGap = Math.min(...gaps) || 1;
    const aisleIndices = gaps
      .map((g, i) => (g > minGap * 1.8 ? i : -1))
      .filter((i) => i !== -1);

    const groups: string[][] = [];
    let start = 0;
    for (const idx of aisleIndices) {
      groups.push(sortedCols.slice(start, idx + 1));
      start = idx + 1;
    }
    groups.push(sortedCols.slice(start));
    const layout = groups.map((g) => g.length).join("-");

    // 走道列：每组的最右列（非最后组）和最左列（非第一组）
    const aisleCols: string[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      if (gi < groups.length - 1) aisleCols.push(groups[gi][groups[gi].length - 1]);
      if (gi > 0) aisleCols.push(groups[gi][0]);
    }

    cabins.push({
      code: cls,
      label: seats[0].label,
      rowStart: rows[0],
      rowEnd: rows[rows.length - 1],
      seatCount: seats.length,
      layout,
      columns: cols,
      windowCols,
      aisleCols,
    });
  }

  // 机翼遮挡排
  const wingRows = [
    ...new Set(
      rawSeats
        .filter((s) => s.features.some((f) => f.name === "wingInWindow"))
        .map((s) => s.row)
    ),
  ].sort((a, b) => a - b);

  // 编码每个座位的 feature bitmask
  const allSeats = rawSeats.map((s) => {
    let f = 0;
    for (const feat of s.features) {
      const bit = F[feat.name as keyof typeof F];
      if (bit) f |= bit;
    }
    return { n: s.number, f };
  });

  // 找出出现次数最多的 feature 值作为默认值
  const featureCounts: Record<number, number> = {};
  for (const s of allSeats) featureCounts[s.f] = (featureCounts[s.f] ?? 0) + 1;
  const defaultFeature = parseInt(
    Object.entries(featureCounts).sort((a, b) => b[1] - a[1])[0][0]
  );

  // 只输出非默认的座位，按 feature 值分组
  const seatExceptions: SeatExceptions = {};
  for (const s of allSeats) {
    if (s.f !== defaultFeature) {
      const key = String(s.f);
      (seatExceptions[key] ??= []).push(s.n);
    }
  }

  // 舱等按排号排序
  cabins.sort((a, b) => a.rowStart - b.rowStart);

  return { planeId, aircraftName, classFeatures, cabins, defaultFeature, seatExceptions, wingRows, F };
}

async function fetchSeatmapHtml(planeId: string): Promise<string> {
  const url = `https://seatmaps.com/seatmaps/${planeId}.html?seatbar=hide&tooltip_on_hover=true&lang=zh-CN`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`获取座位图失败: HTTP ${res.status} (planeId=${planeId})`);
  }
  return res.text();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (mode === "flights") {
    // 模式 1：仅返回航班列表，不拉座位图
    const [from, to, date, airline = "--"] = args;
    if (!from || !to || !date) {
      console.error("用法: bun fetch_seatmap.ts flights <from> <to> <date> [airline]");
      process.exit(1);
    }

    const token = await getToken();
    const routes = await queryFlights(token, from, to, date, airline);

    if (routes.length === 0) {
      console.log(JSON.stringify([]));
      return;
    }

    const flights: object[] = [];
    for (const route of routes) {
      const airlineInfo = route.airlines[0];
      const aircraftByPlaneId: Record<string, Aircraft> = {};
      for (const aircraft of route.aircrafts) {
        aircraftByPlaneId[aircraft.planeId] = aircraft;
      }
      for (const direction of route.directions) {
        for (const flight of direction.flights) {
          const aircraft = aircraftByPlaneId[flight.planeId];
          flights.push({
            flightNo: `${flight.airlineCode}${flight.flightNo}`,
            airlineCode: flight.airlineCode,
            airlineName: airlineInfo?.name,
            departureTime: flight.departureTime,
            arrivalTime: flight.arrivalTime,
            travelTime: flight.travelTime,
            from: direction.departure,
            to: direction.arrival,
            date: flight.departureDate,
            aircraftCode: aircraft?.code,
            aircraftName: aircraft?.name,
            planeId: flight.planeId,
          });
        }
      }
    }

    console.log(JSON.stringify(flights));

  } else {
    // 模式 2：查询单个座位图
    const [planeId, aircraftName] = args;
    if (!planeId || !aircraftName) {
      console.error("用法: bun fetch_seatmap.ts seatmap <planeId> <aircraftName>");
      process.exit(1);
    }

    const html = await fetchSeatmapHtml(planeId);
    const seatmap = parseSeatmapHtml(html, planeId, aircraftName);
    console.log(JSON.stringify(seatmap));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

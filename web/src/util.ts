import { prettyDate, type ISODate } from "../../shared/calendar.ts";

export const fmt = (n: number | null | undefined, digits = 0): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};

export const day = (d: ISODate | null | undefined, dow = true) => (d ? prettyDate(d, dow) : "—");

export function unitLabel(unit: string, n?: number) {
  if (unit === "piece") return n === 1 ? "pc" : "pcs";
  return n === 1 ? "ctn" : "ctns";
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// ---------- photos ----------

export interface PreparedPhoto {
  id: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  problems: string[]; // empty = looks fine
}

const MAX_SIDE = 2200;

/**
 * Downscale to a sensible upload size and run quick checks for the most common
 * bad-photo problems (too small, too dark, washed out, blurry).
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions).catch(() => null);
  if (!bmp) throw new Error("That file is not a photo we can read. Please use a JPEG or PNG.");
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not process photo"))), "image/jpeg", 0.85));
  const problems = checkQuality(bmp);
  bmp.close();
  return { id: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), width: w, height: h, problems };
}

function checkQuality(bmp: ImageBitmap): string[] {
  const problems: string[] = [];
  if (Math.min(bmp.width, bmp.height) < 800) problems.push("Low resolution — move closer or use the main camera");
  const S = 480;
  const scale = S / Math.max(bmp.width, bmp.height);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  let sum = 0;
  let bright = 0;
  for (let i = 0; i < w * h; i++) {
    const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    g[i] = v;
    sum += v;
    if (v > 250) bright++;
  }
  const mean = sum / (w * h);
  if (mean < 70) problems.push("Too dark — turn on a light or move to a brighter spot");
  if (bright / (w * h) > 0.25) problems.push("Glare or overexposed — tilt the sheet away from the light");
  // Variance of the Laplacian: low values mean a blurry photo.
  let lsum = 0;
  let lsq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      lsum += lap;
      lsq += lap * lap;
      n++;
    }
  }
  const variance = lsq / n - (lsum / n) ** 2;
  if (variance < 60) problems.push("Looks blurry — hold steady and tap to focus");
  return problems;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

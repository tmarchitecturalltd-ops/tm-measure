/**
 * A drawing you can look at before you download it.
 *
 * Charlie has BricsCAD. Nobody else here does, so the only way to
 * check a proposal was to download the DXF and open it in a viewer
 * in another tab -- which means a mistake in the geometry is found
 * two steps away from the form that caused it.
 *
 * So the same DXF the button downloads is parsed straight back and
 * drawn as an SVG. Parsing what was just generated rather than
 * drawing from the model on purpose: it checks the file, not the
 * intention. If a wall is missing from the preview it is missing
 * from the file.
 *
 * Only LINE and TEXT are handled, which is all buildProposalDxf
 * emits (it writes polygons as individual LINEs).
 */

export type DxfLine = {
  layer: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
export type DxfText = {
  layer: string;
  x: number;
  y: number;
  h: number;
  value: string;
};

export type DxfParsed = {
  lines: DxfLine[];
  texts: DxfText[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

/** Pull the LINE and TEXT entities out of an R12 DXF. */
export function parseDxf(dxf: string): DxfParsed {
  const rows = dxf.split(/\r?\n/);
  const lines: DxfLine[] = [];
  const texts: DxfText[] = [];

  let type = "";
  let g: Record<number, string> = {};

  const flush = () => {
    const num = (c: number) => Number(g[c] ?? NaN);
    if (type === "LINE") {
      const x1 = num(10), y1 = num(20), x2 = num(11), y2 = num(21);
      if ([x1, y1, x2, y2].every(Number.isFinite)) {
        lines.push({ layer: g[8] ?? "0", x1, y1, x2, y2 });
      }
    } else if (type === "TEXT") {
      const x = num(10), y = num(20);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        texts.push({
          layer: g[8] ?? "0",
          x,
          y,
          h: Number.isFinite(num(40)) ? num(40) : 100,
          value: g[1] ?? "",
        });
      }
    }
    type = "";
    g = {};
  };

  for (let i = 0; i + 1 < rows.length; i += 2) {
    const code = Number(rows[i].trim());
    const value = rows[i + 1];
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      flush();
      type = value.trim();
      continue;
    }
    if (type) g[code] = value.trim();
  }
  flush();

  let bounds: DxfParsed["bounds"] = null;
  const seen = (x: number, y: number) => {
    if (!bounds) bounds = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  };
  for (const l of lines) {
    seen(l.x1, l.y1);
    seen(l.x2, l.y2);
  }
  for (const t of texts) seen(t.x, t.y);

  return { lines, texts, bounds };
}

/**
 * Layer colours, matching what CAD shows.
 *
 * Red is new work, white is existing. Keeping the convention means
 * the preview and Charlie's screen agree, and "the red bit" means
 * the same thing in both.
 */
function colourFor(layer: string): string {
  if (/-PROP|-ELEV-NEW|-BEAMS|-OPENINGS|-DIMS/.test(layer)) return "#ff4d4d";
  if (/-NOTES|-COMPLIANCE|-TEXT/.test(layer)) return "#b9c0c8";
  return "#ffffff";
}

export type DxfSvgOptions = {
  /** Draw only entities on layers matching this, when given. */
  layerFilter?: (layer: string) => boolean;
  /** Width of the rendered box in CSS pixels. */
  width?: number;
  height?: number;
  background?: string;
};

/**
 * The parsed drawing as an SVG, fitted to the box.
 *
 * DXF y is up and SVG y is down, so the whole thing is flipped once
 * at the group rather than per entity -- except the text, which has
 * to be flipped back or it reads upside down.
 */
export function dxfToSvg(dxf: string, opts: DxfSvgOptions = {}): string {
  const { lines, texts, bounds } = parseDxf(dxf);
  const width = opts.width ?? 1200;
  const height = opts.height ?? 800;
  const bg = opts.background ?? "#13161a";

  const keep = opts.layerFilter ?? (() => true);
  const ls = lines.filter((l) => keep(l.layer));
  const ts = texts.filter((t) => keep(t.layer));

  if (!bounds || (ls.length === 0 && ts.length === 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${bg}"/></svg>`;
  }

  const pad = Math.max((bounds.maxX - bounds.minX) * 0.03, 200);
  const minX = bounds.minX - pad;
  const minY = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // One stroke width in drawing units that reads as a hairline at
  // whatever scale the fit landed on.
  const stroke = Math.max(w, h) / 1400;

  const body: string[] = [];
  for (const l of ls) {
    body.push(
      `<line x1="${l.x1.toFixed(1)}" y1="${l.y1.toFixed(1)}" x2="${l.x2.toFixed(1)}" y2="${l.y2.toFixed(1)}" stroke="${colourFor(l.layer)}" stroke-width="${stroke.toFixed(2)}" />`,
    );
  }
  for (const t of ts) {
    if (!t.value) continue;
    body.push(
      `<text x="0" y="0" transform="translate(${t.x.toFixed(1)} ${t.y.toFixed(1)}) scale(1 -1)" font-family="ui-monospace, monospace" font-size="${t.h.toFixed(1)}" fill="${colourFor(t.layer)}">${esc(t.value)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX.toFixed(1)} ${(-(minY + h)).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}">`,
    `<rect x="${minX.toFixed(1)}" y="${(-(minY + h)).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${bg}"/>`,
    `<g transform="scale(1 -1)">`,
    ...body,
    `</g>`,
    `</svg>`,
  ].join("");
}

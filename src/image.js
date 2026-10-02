// Screenshot processing for agents: decode what the hosts produce (desktop
// BMP files, browser PNG data URLs), crop the letterbox and an optional
// region, scale down, and encode a compact JPEG or PNG.
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

// An image is {width, height, data}: RGBA bytes, top row first.

// BMP as written by SDL_SaveBMP (32-bit with bit masks) or any plain 24/32-bit
// BI_RGB / BI_BITFIELDS bitmap, bottom-up or top-down.
export function decodeBmp(buf) {
  if (buf.length < 54 || buf.toString("latin1", 0, 2) !== "BM") throw new Error("not a BMP file");
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (width <= 0 || height === 0) throw new Error("BMP has no pixels");
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP depth ${bpp}`);
  let masks = bpp === 32
    ? [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000]
    : null;
  if (compression === 3 || compression === 6) {
    // BI_BITFIELDS / BI_ALPHABITFIELDS: masks follow a 40-byte header, or sit
    // inside a V4/V5 header.
    const at = 14 + 40;
    masks = [buf.readUInt32LE(at), buf.readUInt32LE(at + 4), buf.readUInt32LE(at + 8),
      headerSize >= 56 || compression === 6 ? buf.readUInt32LE(at + 12) : 0];
  } else if (compression !== 0) {
    throw new Error(`unsupported BMP compression ${compression}`);
  }
  const channel = (mask) => {
    if (!mask) return null;
    let shift = 0;
    while (((mask >>> shift) & 1) === 0) shift += 1;
    const max = mask >>> shift;
    return (v) => Math.round((((v & mask) >>> shift) * 255) / max);
  };
  const [r, g, b, a] = (masks || []).map(channel);
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (bpp === 24) {
        const p = row + x * 3;
        data[o] = buf[p + 2];
        data[o + 1] = buf[p + 1];
        data[o + 2] = buf[p];
        data[o + 3] = 255;
      } else {
        const v = buf.readUInt32LE(row + x * 4);
        data[o] = r(v);
        data[o + 1] = g(v);
        data[o + 2] = b(v);
        data[o + 3] = a ? a(v) : 255;
      }
    }
  }
  return { width, height, data };
}

export function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

// The desktop host letterboxes the virtual area into the window, centred, as
// declgl-desktop's compute_fit_rect does.
export function fitRect(width, height, virtualWidth, virtualHeight) {
  const aspect = virtualWidth / virtualHeight;
  let w;
  let h;
  if (width / height > aspect) {
    h = height;
    w = Math.min(width, Math.round(height * aspect));
  } else {
    w = width;
    h = Math.min(height, Math.round(width / aspect));
  }
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), width: w, height: h };
}

export function crop(img, rect) {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(img.height, Math.round(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) throw new Error("the crop region is outside the image");
  const width = x1 - x0;
  const height = y1 - y0;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    img.data.copy(data, y * width * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1) * 4);
  }
  return { width, height, data };
}

// Box-filter resize: every output pixel averages the source pixels it covers,
// which keeps small text readable when shrinking.
export function resize(img, width, height) {
  if (width === img.width && height === img.height) return img;
  const data = Buffer.alloc(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y += 1) {
    const ya = y * sy;
    const yb = Math.min(img.height, (y + 1) * sy);
    for (let x = 0; x < width; x += 1) {
      const xa = x * sx;
      const xb = Math.min(img.width, (x + 1) * sx);
      const acc = [0, 0, 0, 0];
      let total = 0;
      for (let py = Math.floor(ya); py < Math.ceil(yb); py += 1) {
        const wy = Math.min(yb, py + 1) - Math.max(ya, py);
        for (let px = Math.floor(xa); px < Math.ceil(xb); px += 1) {
          const w = wy * (Math.min(xb, px + 1) - Math.max(xa, px));
          const o = (py * img.width + px) * 4;
          for (let c = 0; c < 4; c += 1) acc[c] += img.data[o + c] * w;
          total += w;
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) data[o + c] = Math.round(acc[c] / total);
    }
  }
  return { width, height, data };
}

export function encode(img, format, quality) {
  if (format === "png") {
    const png = new PNG({ width: img.width, height: img.height });
    img.data.copy(png.data);
    return { mimeType: "image/png", data: PNG.sync.write(png) };
  }
  // JPEG has no alpha: composite onto black, as the window shows it.
  const opaque = Buffer.alloc(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    opaque[i] = img.data[i] * a;
    opaque[i + 1] = img.data[i + 1] * a;
    opaque[i + 2] = img.data[i + 2] * a;
    opaque[i + 3] = 255;
  }
  const out = jpeg.encode({ width: img.width, height: img.height, data: opaque }, quality);
  return { mimeType: "image/jpeg", data: out.data };
}

// From a host capture to the image an agent receives. [view] is where the
// virtual area lies in the capture (null when unknown); [region] is in
// virtual units and needs [view] and [virtualSize].
export function prepare(img, { view, virtualSize, region, maxWidth, format, quality }) {
  let out = view ? crop(img, view) : img;
  let scaleX = virtualSize ? out.width / virtualSize.width : null;
  let scaleY = virtualSize ? out.height / virtualSize.height : null;
  if (region) {
    if (!virtualSize) throw new Error("region needs virtualSize, the game's virtual width and height");
    out = crop(out, {
      x: region.x * scaleX, y: region.y * scaleY,
      width: region.width * scaleX, height: region.height * scaleY,
    });
  }
  // Scale to virtual units when known (one pixel per virtual unit), never
  // wider than maxWidth, never up.
  const wanted = virtualSize ? (region ? region.width : virtualSize.width) : out.width;
  const width = Math.max(1, Math.min(out.width, wanted, maxWidth));
  const height = Math.max(1, Math.round((out.height * width) / out.width));
  const before = out.width;
  out = resize(out, width, height);
  if (scaleX !== null) {
    scaleX *= width / before;
    scaleY *= width / before;
  }
  const encoded = encode(out, format, quality);
  return {
    ...encoded,
    width,
    height,
    pixelsPerUnit: scaleX === null ? null : Number(((scaleX + scaleY) / 2).toFixed(4)),
  };
}

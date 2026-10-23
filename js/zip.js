// Small binary helpers for exports: CRC-32, zlib/deflate through the browser's CompressionStream,
// PNG encoding and a ZIP writer. No dependencies; also runs in Node 18+.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const encoder = new TextEncoder();
export const toBytes = (data) => (typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

// format: 'deflate' (zlib, for PNG) or 'deflate-raw' (for ZIP). Returns null if the browser can't.
export async function compress(bytes, format) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

// zlib stream without compression (stored blocks), for browsers without CompressionStream.
function zlibStored(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, bytes.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(bytes.subarray(start, start + len), o);
    o += len;
  }
  // Adler-32
  let a = 1;
  let s = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    s = (s + a) % 65521;
  }
  new DataView(out.buffer).setUint32(o, ((s << 16) | a) >>> 0);
  return out;
}

// PNG from raw pixels. channels: 1 (grey) or 3 (RGB) or 4 (RGBA); depth 8 or 16 (16 is big-endian
// samples in a Uint16Array).
export async function encodePNG(width, height, pixels, { channels = 3, depth = 8 } = {}) {
  const bpp = channels * (depth / 8);
  const rowLen = width * bpp;
  const raw = new Uint8Array((rowLen + 1) * height);
  const row = new Uint8Array(rowLen);
  for (let y = 0; y < height; y++) {
    if (depth === 16) {
      for (let i = 0; i < width * channels; i++) {
        const v = pixels[y * width * channels + i];
        row[2 * i] = v >>> 8;
        row[2 * i + 1] = v & 0xff;
      }
    } else {
      row.set(pixels.subarray(y * rowLen, (y + 1) * rowLen));
    }
    // "Sub" filter: each byte minus the one a pixel to the left, which compresses smooth images far better.
    const o = y * (rowLen + 1);
    raw[o] = 1;
    for (let i = 0; i < rowLen; i++) raw[o + 1 + i] = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff;
  }
  const idat = (await compress(raw, 'deflate')) ?? zlibStored(raw);
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([depth, colorType, 0, 0, 0], 8);
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ZIP archive from [{ path, data }] (data: string or bytes; a path ending in "/" is a folder).
export async function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = encoder.encode(f.path);
    const isDir = f.path.endsWith('/');
    const data = isDir ? new Uint8Array(0) : toBytes(f.data);
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (data.length > 64) {
      const z = await compress(data, 'deflate-raw');
      if (z && z.length < data.length) {
        method = 8;
        body = z;
      }
    }
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint16(8, method, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, body.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    head.set(name, 30);
    local.push(head, body);

    const cen = new Uint8Array(46 + name.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, isDir ? 0x10 : 0, true);
    c.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += head.length + body.length;
  }
  const cenSize = central.reduce((t, p) => t + p.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cenSize, true);
  e.setUint32(16, offset, true);
  return concat([...local, ...central, end]);
}

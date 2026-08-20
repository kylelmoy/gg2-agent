//=============================================================================
// image.js - turn what the game wrote into something an agent can look at.
//
// GM8's screen_save writes a Windows bitmap whatever extension you give it on
// some builds, and a PNG on others. MCP carries images as base64 with a mime
// type, and a BMP is neither small nor widely accepted, so anything that comes
// back as a bitmap is converted here.
//
// The conversion is done by hand rather than with a library: this repo has one
// dependency and it is not worth a second one for a format that is a header and
// some rows of pixels. zlib does the only hard part.
//=============================================================================

const zlib = require('zlib');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPng = (buf) => buf.length >= 8 && buf.slice(0, 8).equals(PNG_MAGIC);
const isBmp = (buf) => buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d;

//---------------------------------------------------------------------------
// CRC32, as PNG defines it
//---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 8-bit RGB, no interlacing. Every scanline gets filter type 0: the image is a
// screenshot that is about to be looked at once, not stored, so the bytes saved
// by a real filter search are not worth the time.
function encodePng(width, height, rgb) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 3);
    raw[at] = 0;
    rgb.copy(raw, at + 1, y * width * 3, (y + 1) * width * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

//---------------------------------------------------------------------------
// BMP
//---------------------------------------------------------------------------

// Uncompressed 24 and 32 bit bitmaps only - which is all GM8 writes. Rows are
// bottom-up unless the height is negative, and padded to a multiple of four.
function decodeBmp(buf) {
  if (!isBmp(buf) || buf.length < 54) throw new Error('not a bitmap');

  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 40) throw new Error(`unsupported bitmap header (${headerSize} bytes)`);

  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported bitmap depth: ${bpp} bits per pixel`);
  if (compression !== 0 && compression !== 3) throw new Error(`compressed bitmaps are not supported (type ${compression})`);

  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytes = bpp / 8;
  const stride = Math.ceil((width * bytes) / 4) * 4;
  if (dataOffset + stride * height > buf.length) throw new Error('bitmap pixel data is truncated');

  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const from = row + x * bytes;
      const to = (y * width + x) * 3;
      rgb[to] = buf[from + 2]; // BMP stores BGR
      rgb[to + 1] = buf[from + 1];
      rgb[to + 2] = buf[from];
    }
  }
  return { width, height, rgb };
}

// Hand back a PNG whatever the game produced, with the size it turned out to be.
function toPng(buf) {
  if (isPng(buf)) {
    return { png: buf, converted: false, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  const { width, height, rgb } = decodeBmp(buf);
  return { png: encodePng(width, height, rgb), converted: true, width, height };
}

//---------------------------------------------------------------------------
// PNG decoding
//
// Written for the shipped map art (Source/gg2/Included Files/*.png): every one
// of the 22 built-in maps is 8-bit indexed, 8-bit truecolour or 4-bit indexed,
// none interlaced (checked directly against every file in that directory).
// Covers the other standard colour types too since it costs little more, but
// deliberately refuses Adam7 interlacing and 16-bit samples rather than
// guessing - neither shows up in this project's own art, so getting either
// wrong silently would be worse than an error naming what happened.
//---------------------------------------------------------------------------

function readChunks(buf) {
  const chunks = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.slice(at + 8, at + 8 + len);
    chunks.push({ type, data });
    at += 8 + len + 4; // length + type + data + crc
    if (type === 'IEND') break;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Reverses the per-scanline filter (PNG spec section 9), one row at a time.
// bpp is bytes-per-pixel for filtering purposes - the distance back to "the
// pixel to the left", which the spec defines as ceil(bitDepth*channels/8),
// never less than 1 even when a pixel is only a few bits wide.
function unfilterRows(inflated, width, height, bpp, stride) {
  const out = Buffer.alloc(height * stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filterType = inflated[at];
    at += 1;
    const rowIn = inflated.slice(at, at + stride);
    at += stride;
    const rowOut = out.slice(y * stride, y * stride + stride);
    const prevOut = y > 0 ? out.slice((y - 1) * stride, (y - 1) * stride + stride) : null;

    for (let i = 0; i < stride; i++) {
      const x = rowIn[i];
      const a = i >= bpp ? rowOut[i - bpp] : 0;
      const b = prevOut ? prevOut[i] : 0;
      const c = prevOut && i >= bpp ? prevOut[i - bpp] : 0;
      let v;
      switch (filterType) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + Math.floor((a + b) / 2);
          break;
        case 4:
          v = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter type ${filterType} on row ${y}`);
      }
      rowOut[i] = v & 0xff;
    }
  }
  return out;
}

// The k-th sample (0-based) in a row, for bit depths below a whole byte packed
// MSB-first - which is only ever the index channel of a low-depth indexed
// image here, but the unpacking is the same for grayscale too.
function readSample(row, k, bitDepth) {
  if (bitDepth === 8) return row[k];
  const perByte = 8 / bitDepth;
  const byte = row[Math.floor(k / perByte)];
  const shift = 8 - bitDepth * ((k % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function decodePng(buf) {
  if (!isPng(buf)) throw new Error('not a PNG');

  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR');

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  if (bitDepth === 16) throw new Error('16-bit-per-sample PNGs are not supported');
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`unsupported PNG colour type ${colorType}`);

  const palette = chunks.find((c) => c.type === 'PLTE');
  const trns = chunks.find((c) => c.type === 'tRNS');
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const inflated = zlib.inflateSync(idat);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = Math.max(1, Math.ceil((bitDepth * channels) / 8));
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const rows = unfilterRows(inflated, width, height, bpp, stride);

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows.slice(y * stride, y * stride + stride);
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = readSample(row, x, bitDepth);
        if (!palette) throw new Error('indexed PNG has no PLTE chunk');
        rgba[px] = palette.data[idx * 3];
        rgba[px + 1] = palette.data[idx * 3 + 1];
        rgba[px + 2] = palette.data[idx * 3 + 2];
        rgba[px + 3] = trns && idx < trns.data.length ? trns.data[idx] : 255;
      } else if (colorType === 0) {
        const v = readSample(row, x, bitDepth) * (255 / (2 ** bitDepth - 1));
        rgba[px] = rgba[px + 1] = rgba[px + 2] = v;
        rgba[px + 3] = 255;
      } else if (colorType === 4) {
        const base = x * 2;
        rgba[px] = rgba[px + 1] = rgba[px + 2] = row[base];
        rgba[px + 3] = row[base + 1];
      } else if (colorType === 2) {
        const base = x * 3;
        rgba[px] = row[base];
        rgba[px + 1] = row[base + 1];
        rgba[px + 2] = row[base + 2];
        rgba[px + 3] = 255;
      } else {
        // colorType 6: truecolour with alpha
        const base = x * 4;
        rgba[px] = row[base];
        rgba[px + 1] = row[base + 1];
        rgba[px + 2] = row[base + 2];
        rgba[px + 3] = row[base + 3];
      }
    }
  }

  return { width, height, rgba };
}

// 8-bit RGBA, no interlacing, filter type 0 throughout - the write-side twin
// of decodePng's general case, used when the caller wants to keep whatever
// transparency the source had (compositing an overlay onto map art, say)
// rather than flattening it.
function encodePngRgba(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 4);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Nearest-neighbour upscale: exact pixel replication, no blur, which is what
// pixel art wants. factor must be a positive integer.
function scaleNearest(width, height, rgba, factor) {
  if (!Number.isInteger(factor) || factor < 1) throw new Error('scale factor must be a positive integer');
  if (factor === 1) return { width, height, rgba };

  const outW = width * factor;
  const outH = height * factor;
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      for (let dy = 0; dy < factor; dy++) {
        const rowAt = ((y * factor + dy) * outW + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++) {
          rgba.copy(out, rowAt + dx * 4, src, src + 4);
        }
      }
    }
  }
  return { width: outW, height: outH, rgba: out };
}

module.exports = {
  toPng,
  encodePng,
  encodePngRgba,
  decodePng,
  decodeBmp,
  scaleNearest,
  isPng,
  isBmp,
  crc32,
};

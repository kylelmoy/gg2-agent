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

module.exports = { toPng, encodePng, decodeBmp, isPng, isBmp, crc32 };

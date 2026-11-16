/**
 * Minimal decoder for the 8-bit RGB/RGBA non-interlaced PNGs used by the
 * Terrarium terrain tiles. Avoids an image dependency in the server bundle.
 */

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** 3 = RGB, 4 = RGBA */
  channels: 3 | 4;
  /** Row-major, 8 bits per channel. */
  pixels: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function fail(message: string): never {
  throw new Error(`Invalid PNG: ${message}`);
}

function readUInt32(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes the PNG subset used by Terrarium tiles. */
export function decodePng(buffer: Uint8Array): DecodedPng {
  if (buffer.length < 33) fail('too short');
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buffer[i] !== PNG_SIGNATURE[i]) fail('bad signature');
  }

  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = readUInt32(buffer, offset);
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7]
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) fail('truncated chunk');

    if (type === 'IHDR') {
      if (length < 13) fail('short IHDR');
      width = readUInt32(buffer, dataStart);
      height = readUInt32(buffer, dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      interlace = buffer[dataStart + 12];
      if (compression !== 0 || filter !== 0) fail('unsupported compression/filter method');
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }

  if (!width || !height) fail('missing IHDR');
  if (bitDepth !== 8) fail(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) fail('interlaced PNGs are not supported');
  if (colorType !== 2 && colorType !== 6) fail(`unsupported color type ${colorType}`);
  if (idat.length === 0) fail('missing IDAT');

  const channels = (colorType === 2 ? 3 : 4) as 3 | 4;
  const rowBytes = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (rowBytes + 1) * height) fail('short image data');

  const pixels = new Uint8Array(rowBytes * height);
  let input = 0;
  let previous = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[input];
    input += 1;
    if (input + rowBytes > raw.length) fail('truncated scanline');
    const row = raw.subarray(input, input + rowBytes);
    input += rowBytes;
    const out = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const value = row[x];
      switch (filter) {
        case 0:
          out[x] = value;
          break;
        case 1:
          out[x] = (value + left) & 0xff;
          break;
        case 2:
          out[x] = (value + up) & 0xff;
          break;
        case 3:
          out[x] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          out[x] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          fail(`unknown filter type ${filter}`);
      }
    }
    previous = out;
  }

  return { width, height, channels, pixels };
}

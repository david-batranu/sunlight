#!/usr/bin/env node
/**
 * Builds the bundled global city search index from GeoNames `cities5000`.
 *
 *   node scripts/build-city-index.mjs
 *   GEONAMES_SOURCE=/path/to/cities5000.txt node scripts/build-city-index.mjs
 *
 * The derived file contains only the fields Sunlight needs. GeoNames data is
 * licensed under CC BY 4.0 — see https://www.geonames.org/.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_DIR = path.join(ROOT, '.cache', 'geonames');
const OUT_FILE = path.join(ROOT, 'server', 'data', 'cities.json.gz');
const ZIP_URL = 'https://download.geonames.org/export/dump/cities5000.zip';

function resolveSource() {
  if (process.env.GEONAMES_SOURCE) {
    if (!existsSync(process.env.GEONAMES_SOURCE)) {
      throw new Error(`GEONAMES_SOURCE does not exist: ${process.env.GEONAMES_SOURCE}`);
    }
    return process.env.GEONAMES_SOURCE;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const txt = path.join(CACHE_DIR, 'cities5000.txt');
  if (existsSync(txt)) return txt;
  const zip = path.join(CACHE_DIR, 'cities5000.zip');
  if (!existsSync(zip)) {
    console.log(`downloading ${ZIP_URL} ...`);
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', zip, ZIP_URL], { stdio: 'inherit' });
  }
  console.log('extracting ...');
  execFileSync('unzip', ['-o', '-q', zip, '-d', CACHE_DIR], { stdio: 'inherit' });
  if (!existsSync(txt)) throw new Error(`expected ${txt} after unzip`);
  return txt;
}

function main() {
  const source = resolveSource();
  const raw = readFileSync(source, 'utf8');
  const cities = [];
  let skipped = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 19) {
      skipped += 1;
      continue;
    }
    const [id, name, ascii, , latS, lonS, featureClass, featureCode, cc, , admin1, , , , popS, , , tz] = f;
    // GeoNames already filters to >= 5000 inhabitants; keep populated places only.
    if (featureClass !== 'P') {
      skipped += 1;
      continue;
    }
    // PPLX is a "section of populated place" (neighbourhood); city search should not return those.
    if (featureCode === 'PPLX') {
      skipped += 1;
      continue;
    }
    const lat = Number(latS);
    const lon = Number(lonS);
    const population = Number(popS) || 0;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !tz) {
      skipped += 1;
      continue;
    }
    cities.push([
      Number(id),
      name,
      ascii,
      cc,
      admin1 || '',
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5,
      tz,
      population
    ]);
  }

  cities.sort((a, b) => b[8] - a[8]);

  const payload = {
    v: 1,
    source: 'GeoNames cities5000',
    attribution: 'GeoNames (CC BY 4.0)',
    generatedAt: new Date().toISOString(),
    count: cities.length,
    // [geonameId, name, asciiName, cc, admin1, lat, lon, tz, population]
    cities
  };

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const buf = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  writeFileSync(OUT_FILE, buf);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)}: ${cities.length} cities, ${(buf.length / 1e6).toFixed(2)} MB gzipped (skipped ${skipped})`);
}

main();

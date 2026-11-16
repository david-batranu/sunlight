/**
 * `tz-lookup` ships no TypeScript declarations (and `@types/tz-lookup` is not a
 * dependency), so the tiny surface we use is declared here.
 */
declare module 'tz-lookup' {
  /** Returns the IANA timezone name for a coordinate (nearest zone). */
  export default function tzlookup(lat: number, lon: number): string;
}

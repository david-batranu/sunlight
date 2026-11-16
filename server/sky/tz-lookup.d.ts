/**
 * Minimal ambient types for `tz-lookup`, which ships JavaScript only.
 * The package resolves an IANA timezone name from geographic coordinates and
 * throws when the coordinates are invalid.
 */
declare module 'tz-lookup' {
  /** Returns the IANA timezone name for the given latitude/longitude. */
  function tzlookup(latitude: number, longitude: number): string;
  export default tzlookup;
}

# City data fixtures

Deterministic local raw-OSM fixtures used by `CITY_SOURCE=fixture` and the city
unit tests. Nothing here touches the network.

## `raw-city.json`

A hand-crafted Overpass JSON response in the same shape Overpass returns for

```text
[out:json][timeout:25];
( way["building"](bbox); way["highway"](bbox); ... );
out tags geom qt;
```

i.e. ways carry inline `geometry` arrays and relation members carry inline
geometry too. It is centred on Brașov (`45.64861, 25.60613`) and exercises:

- 11 building ways (house / apartments / commercial / school / church /
  industrial / boundary-clipped / tiny shed) plus excluded `building:part` and
  `building=no` ways,
- a `building` multipolygon relation assembled from two outer ways with a
  courtyard inner ring (holes on buildings are ignored by the builder),
- water (closed way and a multipolygon relation with an island hole),
- park, forest, grass and plaza polygons,
- road classes 1/2/3/4, a railway, and filtered unnamed-service / tunnel ways.

Wrapper format:

```json
{
  "v": 1,
  "format": "overpass-json",
  "center": { "lat": 45.64861, "lon": 25.60613 },
  "data": { "version": 0.6, "elements": [ ... ] }
}
```

The fixture provider also accepts a bare Overpass JSON object
(`{"elements":[...]}`), OSM API XML (`.xml`), and the wrapper formats
(`{"format":"overpass-json","data":...}` / `{"format":"osm-xml","text":"..."}`).
Wrapped fixtures that declare `center` are translated to the requested target
centre, so `CITY_SOURCE=fixture` can serve any city or point deterministically.

Resolution order: `raw-city-<geonameId>.json|.xml`,
`raw-point-<lat>_<lon>.json|.xml`, then `raw-city.json|.xml`.

## `raw-tile.xml`

A small OSM API `/api/0.6/map` response with node-referenced ways, used to test
the SAX XML parser and the tiled OSM API fallback with mocked HTTP responses.

import { html, useEffect, useRef } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import { lonAlongTrack, unwrapCoordinates } from '../track.mjs';

const TRACK_COLOUR = '#e8590c';
const DEPARTURE_COLOUR = '#2b8a3e';
const ARRIVAL_COLOUR = '#c92a2a';
const BOAT_COLOUR = '#1d4ed8';

// A small sailboat, bow first, drawn pointing north (up) so it can be
// rotated in place to the selected point's heading or course.
function boatIcon(headingRadians) {
  const degrees = ((headingRadians * 180) / Math.PI).toFixed(1);
  return L.divIcon({
    className: 'boat-marker',
    html: `<svg viewBox="0 0 24 24" width="26" height="26" style="transform: rotate(${degrees}deg); transform-origin: center;"><path d="M12 2 18.5 20 12 16.5 5.5 20 Z" fill="${BOAT_COLOUR}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round" /></svg>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}

// Signal K serves every page with `Referrer-Policy: no-referrer`, and the
// OpenStreetMap tile servers answer a request without a Referer with an
// "Access blocked" tile. Send the origin only, as browsers do by default.
const TILE_REFERRER_POLICY = 'strict-origin-when-cross-origin';

// Leaflet renders a string tooltip as HTML; place names are typed by the crew.
function textTooltip(text) {
  const element = document.createElement('span');
  element.textContent = text;
  return element;
}

export function TrackMap({ track, entry, boat }) {
  const { t } = useLocale();
  const container = useRef(null);
  const map = useRef(null);
  const overlay = useRef(null);
  const fitted = useRef(false);
  const boatMarker = useRef(null);
  const unwrapped = useRef([]);

  useEffect(() => {
    const instance = L.map(container.current, { scrollWheelZoom: false });
    const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: TILE_REFERRER_POLICY,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(instance);
    const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      maxZoom: 18,
      referrerPolicy: TILE_REFERRER_POLICY,
      attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>'
    }).addTo(instance);
    L.control.layers({ OpenStreetMap: streets }, { [t('map.seamarks')]: seamarks }).addTo(instance);
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  // Redrawn on each refresh of a passage in progress, without resetting the
  // view the reader may have zoomed to.
  useEffect(() => {
    const instance = map.current;
    overlay.current?.remove();
    const group = L.featureGroup();

    const geometry = track?.geometry;
    const coordinates =
      geometry?.type === 'LineString'
        ? unwrapCoordinates(geometry.coordinates)
        : geometry?.type === 'Point'
          ? [geometry.coordinates]
          : [];
    unwrapped.current = coordinates;
    if (geometry) {
      const drawn = {
        ...track,
        geometry: {
          ...geometry,
          coordinates: geometry.type === 'Point' ? coordinates[0] : coordinates
        }
      };
      L.geoJSON(drawn, { style: { color: TRACK_COLOUR, weight: 3, opacity: 0.9 } }).addTo(group);
    }
    const ends = [[entry.startPosition, entry.startPlaceName, DEPARTURE_COLOUR]];
    if (entry.endTime) {
      ends.push([entry.endPosition, entry.endPlaceName, ARRIVAL_COLOUR]);
    }
    for (const [position, name, colour] of ends) {
      if (position) {
        L.circleMarker([position.lat, lonAlongTrack(coordinates, position.lat, position.lon)], {
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: colour,
          fillOpacity: 1
        })
          .bindTooltip(textTooltip(name ?? t('place.unknown')))
          .addTo(group);
      }
    }

    group.addTo(instance);
    overlay.current = group;
    const bounds = group.getBounds();
    if (!fitted.current && bounds.isValid()) {
      // Not animated: the boat marker below is added right after this, in its
      // own effect, and Leaflet places a layer added mid pan/zoom animation
      // at a stale, wildly wrong pixel position that a later setLatLng never
      // corrects.
      instance.fitBounds(bounds, { padding: [24, 24], maxZoom: 15, animate: false });
      fitted.current = true;
    }
  }, [track, entry]);

  // Kept separate from the track/ends effect above: moving the position
  // scrubber must not redraw the whole track or refit the view each time.
  useEffect(() => {
    const instance = map.current;
    if (!instance) {
      return;
    }
    if (!boat) {
      boatMarker.current?.remove();
      boatMarker.current = null;
      return;
    }
    const icon = boatIcon(boat.heading ?? boat.cog ?? 0);
    const boatLon = lonAlongTrack(unwrapped.current, boat.lat, boat.lon);
    if (boatMarker.current) {
      boatMarker.current.setLatLng([boat.lat, boatLon]);
      boatMarker.current.setIcon(icon);
    } else {
      boatMarker.current = L.marker([boat.lat, boatLon], {
        icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000
      }).addTo(instance);
    }
  }, [boat]);

  return html`<div class="track-map" ref=${container}></div>`;
}

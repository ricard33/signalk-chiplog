// The boat of the 3D view: a sailboat built in code, or the crew's own model.
//
// Both are one unit long, bow towards +z, y up, with the waterline at y = 0, so
// the renderer scales either to whatever the camera needs. Nothing is a file:
// the default boat is generated, so there is no asset to ship or to credit.
//
// The default boat is drawn as a cartoon rather than as a rendering: stepped
// toon shading instead of a smooth gradient, flat colours in bands that follow
// the sheer, a dark outline around every solid, and proportions pushed past a
// real hull's — a deep sheer, a full bow, a roached mainsail. On the film the
// boat is a sixth of the frame at most, where only the silhouette and the
// blocks of colour read; everything here is chosen to survive that.

import * as THREE from '../../vendor/three.min.mjs';
import { findSails, SAIL_ROLES } from './boat-parts.mjs';

const HULL_LENGTH = 1;
// The canoe body only: the boat is drawn over the sea with a fresh depth buffer,
// so whatever is below the waterline shows. A fin and a rudder would hang in
// plain sight under a boat that has no water around it — hence a shallow,
// rounded bottom and no appendages.
const DRAUGHT = 0.05;

const HULL_STATIONS = [
  // u: along the hull from the stern. `beam` is the half beam, `deck` the height
  // of the rail above the water — its curve is the sheer — and `rake` how far aft
  // (bow) or forward (stern) a point moves per unit of height below the rail,
  // which is what gives the overhangs.
  { u: 0, beam: 0.118, deck: 0.113, rake: 0.42 },
  { u: 0.08, beam: 0.142, deck: 0.102, rake: 0.3 },
  { u: 0.22, beam: 0.163, deck: 0.09, rake: 0.14 },
  { u: 0.42, beam: 0.172, deck: 0.083, rake: 0 },
  { u: 0.6, beam: 0.166, deck: 0.087, rake: -0.08 },
  { u: 0.76, beam: 0.136, deck: 0.1, rake: -0.24 },
  { u: 0.88, beam: 0.087, deck: 0.122, rake: -0.42 },
  { u: 0.96, beam: 0.036, deck: 0.142, rake: -0.56 },
  { u: 1, beam: 0.004, deck: 0.154, rake: -0.62 }
];

// One half of a cross-section, from the rail down to the keel, as fractions of
// the half beam and — above the water — of the rail height, so every band keeps
// its distance from the sheer the whole length of the boat. A band boundary is a
// point given twice, once in each colour: the join is then a clean edge rather
// than a fade.
const SECTION = [
  { x: 1, y: 'deck', colour: 'topsides' },
  { x: 1, y: 0.75, colour: 'topsides' },
  { x: 1, y: 0.75, colour: 'stripe' },
  { x: 0.995, y: 0.55, colour: 'stripe' },
  { x: 0.995, y: 0.55, colour: 'topsides' },
  { x: 0.985, y: 0.2, colour: 'topsides' },
  { x: 0.985, y: 0.2, colour: 'boot' },
  { x: 0.95, y: 0, colour: 'boot' },
  { x: 0.95, y: 0, colour: 'bottom' },
  { x: 0.79, y: -0.45, colour: 'bottom' },
  { x: 0.49, y: -0.82, colour: 'bottom' },
  { x: 0.15, y: -1, colour: 'bottom' }
];

// A cartoon's palette: few colours, each well clear of the next. The hull is
// the strong one so that it parts from the white of the sails and from the sea,
// which is the only separation left when the boat is a hundred pixels long.
const COLOURS = {
  topsides: new THREE.Color('#d33f26'),
  stripe: new THREE.Color('#fdf6e6'),
  boot: new THREE.Color('#13405f'),
  bottom: new THREE.Color('#0c2a3d'),
  deck: new THREE.Color('#ecca90'),
  covering: new THREE.Color('#fdf6e6'),
  cabin: new THREE.Color('#fdf6e6'),
  cabinTrim: new THREE.Color('#13405f'),
  glass: new THREE.Color('#13293c'),
  metal: new THREE.Color('#c3ccd4'),
  well: new THREE.Color('#5b4835'),
  sail: new THREE.Color('#fffdf8'),
  sailBand: new THREE.Color('#d33f26'),
  burgee: new THREE.Color('#d33f26'),
  crew: new THREE.Color('#f5c542'),
  skin: new THREE.Color('#e8b48b'),
  outline: new THREE.Color('#17242f')
};

// The tones a surface is shaded in. Toon shading reads this ladder rather than a
// smooth falloff, so a hull turning away from the sun steps from one flat tone to
// the next instead of grading into shadow — the thing that says "drawn" rather
// than "lit". Under the animation's own bright sky most faces land on the top
// step, which is what keeps the colours flat and the shading to the turn of the
// bilge and the shaded side of a sail.
const TOON_STEPS = new Uint8Array([96, 168, 255]);
let gradient = null;

function toonGradient() {
  if (!gradient) {
    gradient = new THREE.DataTexture(TOON_STEPS, TOON_STEPS.length, 1, THREE.RedFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

function material(colour, options = {}) {
  return new THREE.MeshToonMaterial({ color: colour, gradientMap: toonGradient(), ...options });
}

function mesh(geometry, colour, options) {
  return new THREE.Mesh(geometry, material(colour, options));
}

// The outline, drawn as the solid itself seen from the inside and swollen along
// its normals: what is left showing around the silhouette is a band of the
// swelling. Its thickness is in the boat's own units, so it stays the same
// fraction of the boat however near the camera is — an inked line, not a rim.
const OUTLINE_VERTEX = `
  uniform float uThickness;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uThickness, 1.0);
  }
`;
const OUTLINE_FRAGMENT = `
  uniform vec3 uColor;
  void main() {
    gl_FragColor = linearToOutputTexel(vec4(uColor, 1.0));
  }
`;

// The ink's own copy of a shape, with the normals of every vertex that shares a
// place averaged together. A band boundary or a box corner is two vertices in one
// spot with normals of their own; offsetting each along its own normal would tear
// the outline open there, and averaging closes it.
function inkGeometry(geometry) {
  const ink = geometry.clone();
  ink.computeVertexNormals();
  const position = ink.getAttribute('position');
  const normal = ink.getAttribute('normal');
  const places = new Map();
  const key = (i) =>
    [position.getX(i), position.getY(i), position.getZ(i)]
      .map((value) => Math.round(value * 1e4))
      .join(',');
  for (let i = 0; i < position.count; i += 1) {
    const place = key(i);
    let sum = places.get(place);
    if (!sum) {
      sum = { x: 0, y: 0, z: 0, at: [] };
      places.set(place, sum);
    }
    sum.x += normal.getX(i);
    sum.y += normal.getY(i);
    sum.z += normal.getZ(i);
    sum.at.push(i);
  }
  for (const sum of places.values()) {
    const length = Math.hypot(sum.x, sum.y, sum.z) || 1;
    for (const i of sum.at) {
      normal.setXYZ(i, sum.x / length, sum.y / length, sum.z / length);
    }
  }
  normal.needsUpdate = true;
  return ink;
}

function outline(target, thickness) {
  const ink = new THREE.Mesh(
    inkGeometry(target.geometry),
    new THREE.ShaderMaterial({
      vertexShader: OUTLINE_VERTEX,
      fragmentShader: OUTLINE_FRAGMENT,
      uniforms: { uThickness: { value: thickness }, uColor: { value: COLOURS.outline } },
      side: THREE.BackSide
    })
  );
  target.add(ink);
  return target;
}

function interpolateStation(u, key) {
  for (let i = 0; i < HULL_STATIONS.length - 1; i += 1) {
    const a = HULL_STATIONS[i];
    const b = HULL_STATIONS[i + 1];
    if (u <= b.u) {
      const t = (u - a.u) / (b.u - a.u);
      const eased = t * t * (3 - 2 * t);
      return a[key] + (b[key] - a[key]) * eased;
    }
  }
  return HULL_STATIONS[HULL_STATIONS.length - 1][key];
}

// A section's points in the boat's own frame: starboard is -x, and the rake
// swings the lower ones fore or aft so the ends overhang.
function sectionRing(u) {
  const z = (u - 0.5) * HULL_LENGTH;
  const beam = interpolateStation(u, 'beam');
  const deck = interpolateStation(u, 'deck');
  const rake = interpolateStation(u, 'rake');
  const half = SECTION.map((point) => {
    const y = point.y === 'deck' ? deck : point.y * (point.y < 0 ? DRAUGHT : deck);
    return { x: point.x * beam, y, z: z + rake * (deck - y), colour: COLOURS[point.colour] };
  });
  // Down the starboard side, then up the port one, so the ring closes.
  return [
    ...half.map((point) => ({ ...point, x: -point.x })),
    ...half
      .slice()
      .reverse()
      .map((point) => ({ ...point }))
  ];
}

function buildHull() {
  const stations = 40;
  const positions = [];
  const colours = [];
  const indices = [];
  const rings = [];
  for (let s = 0; s <= stations; s += 1) {
    rings.push(sectionRing(s / stations));
  }
  const ringSize = rings[0].length;
  for (const ring of rings) {
    for (const point of ring) {
      positions.push(point.x, point.y, point.z);
      colours.push(point.colour.r, point.colour.g, point.colour.b);
    }
  }
  // The ring is left open across the top: the hull is a shell the deck fills,
  // and the topsides standing above the deck are the bulwark.
  for (let s = 0; s < stations; s += 1) {
    for (let i = 0; i < ringSize - 1; i += 1) {
      const a = s * ringSize + i;
      const b = s * ringSize + i + 1;
      const c = (s + 1) * ringSize + i;
      const d = (s + 1) * ringSize + i + 1;
      // Wound so the normals face out of the hull: the outline needs an inside.
      indices.push(a, b, c, b, d, c);
    }
  }
  // The transom closes the after end — without it the hull is a tube, and the
  // outline would ink the sea through it.
  const transom = rings[0];
  const base = positions.length / 3;
  for (const point of transom) {
    positions.push(point.x, point.y, point.z);
    colours.push(point.colour.r, point.colour.g, point.colour.b);
  }
  for (let i = 1; i < ringSize - 1; i += 1) {
    indices.push(base, base + i + 1, base + i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Where the cockpit is cut out of the deck, and how deep its well goes.
const WELL = { aft: -0.35, forward: -0.1, halfWidth: 0.07, depth: 0.042 };

// The deck lands on the section's second point, the one at the full beam, so it
// meets the topsides exactly there and the rail stands proud of it.
const DECK_TOP = SECTION[1].y;

function deckLevel(z) {
  return interpolateStation(z / HULL_LENGTH + 0.5, 'deck') * DECK_TOP;
}

function deckBeam(z) {
  return interpolateStation(z / HULL_LENGTH + 0.5, 'beam');
}

// How wide a covering board is laid along the edge of the deck: a pale border
// that keeps the planking from meeting the topsides in one flat expanse, which
// is most of what a camera looking down at 50° sees.
const COVERING_BOARD = 0.016;

// The stretches of a station the deck is laid over, from port to starboard, each
// with the colour it is laid in: a covering board either side, planking between,
// and nothing at all where the cockpit is cut out of it.
function deckSpans(z, beam) {
  const board = Math.min(COVERING_BOARD, beam * 0.45);
  const inner = beam - board;
  // The planking meets on the centreline everywhere but over the cockpit, where
  // each side stops at the coaming. Always the same four stretches, in the same
  // order, so consecutive stations join up — and so the station where the well
  // begins closes its end with planking of its own.
  const cut = z > WELL.aft && z < WELL.forward && inner > WELL.halfWidth ? WELL.halfWidth : 0;
  return [
    { from: -beam, to: -inner, colour: COLOURS.covering },
    { from: inner, to: beam, colour: COLOURS.covering },
    { from: -inner, to: -cut, colour: COLOURS.deck },
    { from: cut, to: inner, colour: COLOURS.deck }
  ];
}

// The deck follows the sheer, and stops short of the cockpit opening.
function buildDeck() {
  const stations = 44;
  const positions = [];
  const colours = [];
  const indices = [];
  const add = (corners, colour) => {
    const base = positions.length / 3;
    for (const corner of corners) {
      positions.push(...corner);
      colours.push(colour.r, colour.g, colour.b);
    }
    // Anticlockwise seen from above, so the deck faces the sky.
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  for (let s = 0; s < stations; s += 1) {
    const z0 = (s / stations - 0.5) * HULL_LENGTH;
    const z1 = ((s + 1) / stations - 0.5) * HULL_LENGTH;
    const y0 = deckLevel(z0);
    const y1 = deckLevel(z1);
    const aft = deckSpans(z0, deckBeam(z0));
    const forward = deckSpans(z1, deckBeam(z1));
    // A span is only laid where the stations either side of it agree there is
    // one: the ends of the cockpit are then closed off by the planking itself.
    for (let i = 0; i < aft.length; i += 1) {
      add(
        [
          [aft[i].from, y0, z0],
          [aft[i].to, y0, z0],
          [forward[i].to, y1, z1],
          [forward[i].from, y1, z1]
        ],
        aft[i].colour
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// A solid whose top face is smaller than its bottom one and offset along the
// boat: a coachroof rather than a crate. Corners are given as half widths and
// z bounds; the caller places it.
function taperedBox({ bottom, top, base, height }) {
  const corners = [
    [-bottom.halfWidth, base, bottom.aft],
    [bottom.halfWidth, base, bottom.aft],
    [bottom.halfWidth, base, bottom.forward],
    [-bottom.halfWidth, base, bottom.forward],
    [-top.halfWidth, base + height, top.aft],
    [top.halfWidth, base + height, top.aft],
    [top.halfWidth, base + height, top.forward],
    [-top.halfWidth, base + height, top.forward]
  ];
  // Wound anticlockwise seen from outside, so the normals face out and the
  // outline has an inside to hide in.
  const faces = [
    [1, 2, 3, 0], // bottom
    [7, 6, 5, 4], // top
    [4, 5, 1, 0], // aft
    [2, 6, 7, 3], // forward
    [3, 7, 4, 0], // port
    [5, 6, 2, 1] // starboard
  ];
  const positions = [];
  const indices = [];
  for (const face of faces) {
    const base_ = positions.length / 3;
    for (const corner of face) {
      positions.push(...corners[corner]);
    }
    indices.push(base_, base_ + 1, base_ + 2, base_, base_ + 2, base_ + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const MAST_Z = 0.12;
const CABIN_TOP = 0.133;
const MAST_FOOT = CABIN_TOP - 0.004;
const MAST_HEIGHT = 0.63;
const MASTHEAD = MAST_FOOT + MAST_HEIGHT;
const BOOM_Z = -0.22;
const BOOM_Y = 0.2;
const FORESTAY_TACK = [0, 0.126, 0.455];
const FORESTAY_HEAD = [0, MASTHEAD - 0.035, MAST_Z + 0.012];

// A point of a triangular sail, from its barycentric weights: `a` towards the
// head, `b` towards the clew, the rest at the tack. `camber` bellies the cloth
// out of its own plane, `roach` bows the leech out past the straight line from
// the head to the clew, the way a battened mainsail's does.
function sailPoint(corners, a, b, camber, roach, outward) {
  const [tack, head, clew] = corners;
  const w = 1 - a - b;
  const point = [0, 1, 2].map((k) => tack[k] * w + head[k] * a + clew[k] * b);
  point[0] +=
    camber * Math.sin(Math.PI * Math.min(1, a * 1.6)) * Math.sin(Math.PI * (b * 0.8 + 0.1));
  if (roach && outward) {
    const along = a + b;
    // Fullest halfway up the leech, and only near it: nothing moves by the mast.
    const t = along > 1e-6 ? a / along : 0;
    const near = Math.max(0, (along - 0.5) / 0.5);
    const push = roach * Math.sin(Math.PI * t) * near * near;
    point[1] += outward.y * push;
    point[2] += outward.z * push;
  }
  return point;
}

// The direction the leech bows out in, in the sail's own plane.
function leechOutward(corners) {
  const [tack, head, clew] = corners;
  const leech = new THREE.Vector3(clew[0] - head[0], clew[1] - head[1], clew[2] - head[2]);
  const toTack = new THREE.Vector3(tack[0] - head[0], tack[1] - head[1], tack[2] - head[2]);
  const along = leech.clone().multiplyScalar(toTack.dot(leech) / Math.max(1e-9, leech.lengthSq()));
  return toTack.clone().sub(along).negate().normalize();
}

function sailGeometry(corners, { camber = 0, roach = 0, rows = 9 } = {}) {
  const outward = leechOutward(corners);
  const positions = [];
  const indices = [];
  for (let r = 0; r <= rows; r += 1) {
    for (let c = 0; c <= rows - r; c += 1) {
      positions.push(...sailPoint(corners, r / rows, c / rows, camber, roach, outward));
    }
  }
  const at = (r, c) => {
    let offset = 0;
    for (let i = 0; i < r; i += 1) {
      offset += rows - i + 1;
    }
    return offset + c;
  };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < rows - r; c += 1) {
      indices.push(at(r, c), at(r + 1, c), at(r, c + 1));
      if (c < rows - r - 1) {
        indices.push(at(r, c + 1), at(r + 1, c), at(r + 1, c + 1));
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// The stripe across the mainsail: the same surface over a band of the cloth, so
// it belongs to the sail whatever the cloth is doing, lifted over it by the
// depth offset rather than by a gap that would show edge on.
function sailBandGeometry(corners, options, from, to) {
  const { camber = 0, roach = 0 } = options;
  const outward = leechOutward(corners);
  const steps = 10;
  const positions = [];
  const indices = [];
  for (const a of [from, to]) {
    for (let i = 0; i <= steps; i += 1) {
      positions.push(...sailPoint(corners, a, (i / steps) * (1 - a), camber, roach, outward));
    }
  }
  for (let i = 0; i < steps; i += 1) {
    const top = steps + 1 + i;
    indices.push(i, top, i + 1, i + 1, top, top + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Cloth is lit through as much as it is lit on, so a sail keeps its colour on
// the shaded side: without that lift the leeward face of a white mainsail comes
// out the same grey as the sea behind it.
function sailMaterial(colour = COLOURS.sail, extra = {}) {
  return material(colour, {
    side: THREE.DoubleSide,
    emissive: colour.clone().multiplyScalar(0.32),
    ...extra
  });
}

// A rod between two points: a stay, a shroud, a lifeline.
function rod(from, to, radius, colour) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const bar = mesh(new THREE.CylinderGeometry(radius, radius, 1, 5), colour);
  bar.position.copy(start).add(end).multiplyScalar(0.5);
  bar.scale.y = start.distanceTo(end);
  bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
  return bar;
}

export function createProceduralBoat() {
  const root = new THREE.Group();

  // Both sides: the shell is open at the rail, and it is the inner face of the
  // far bulwark that keeps the outline — drawn as the hull swollen and seen from
  // within — from showing through the boat.
  const hull = mesh(buildHull(), 0xffffff, { vertexColors: true, side: THREE.DoubleSide });
  outline(hull, 0.005);
  root.add(hull);
  root.add(mesh(buildDeck(), 0xffffff, { vertexColors: true, side: THREE.DoubleSide }));

  // The cockpit, as a box seen from the inside: the deck opening is its rim, and
  // only the walls and the sole facing the camera are drawn. The deck sheers up
  // towards the stern over the length of the well, so the box is tilted to match
  // — level, its top would stand proud of the deck at one end and sink below it
  // at the other, where the opening would show straight through the boat.
  const wellLength = WELL.forward - WELL.aft;
  const wellMiddle = (WELL.forward + WELL.aft) / 2;
  const wellTop = (deckLevel(WELL.aft) + deckLevel(WELL.forward)) / 2;
  const wellSlope = Math.atan2(deckLevel(WELL.aft) - deckLevel(WELL.forward), wellLength);
  const well = mesh(
    new THREE.BoxGeometry(WELL.halfWidth * 2, WELL.depth, wellLength),
    COLOURS.well,
    { side: THREE.BackSide }
  );
  well.position.set(0, wellTop - WELL.depth / 2, wellMiddle);
  well.rotation.x = wellSlope;
  root.add(well);

  // A coaming either side of it, chunky enough to read as one.
  for (const side of [-1, 1]) {
    const coaming = mesh(new THREE.BoxGeometry(0.013, 0.02, wellLength + 0.02), COLOURS.cabin);
    coaming.position.set(side * (WELL.halfWidth + 0.006), wellTop + 0.008, wellMiddle + 0.005);
    coaming.rotation.x = wellSlope;
    outline(coaming, 0.0025);
    root.add(coaming);
  }

  const cabin = mesh(
    taperedBox({
      bottom: { halfWidth: 0.092, aft: -0.085, forward: 0.225 },
      top: { halfWidth: 0.07, aft: -0.055, forward: 0.185 },
      base: 0.071,
      height: CABIN_TOP - 0.071
    }),
    COLOURS.cabin
  );
  outline(cabin, 0.004);
  root.add(cabin);

  // A stripe along the coachroof, and round portholes in it: two blocks of
  // colour that still read when the boat is a hundred pixels wide.
  const trim = mesh(new THREE.BoxGeometry(0.19, 0.012, 0.3), COLOURS.cabinTrim);
  trim.position.set(0, 0.079, 0.07);
  root.add(trim);
  for (const side of [-1, 1]) {
    for (const z of [-0.01, 0.06, 0.13]) {
      const port = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.006, 10), COLOURS.glass);
      port.rotation.z = Math.PI / 2;
      port.position.set(side * 0.086, 0.105, z);
      root.add(port);
    }
  }
  // The way below, a dark opening in the after face of the coachroof.
  const companionway = mesh(new THREE.BoxGeometry(0.06, 0.04, 0.012), COLOURS.glass);
  companionway.position.set(0, 0.099, -0.083);
  root.add(companionway);

  const mast = mesh(new THREE.CylinderGeometry(0.0055, 0.0075, MAST_HEIGHT, 10), COLOURS.metal);
  mast.position.set(0, MAST_FOOT + MAST_HEIGHT / 2, MAST_Z);
  outline(mast, 0.002);
  root.add(mast);
  for (const side of [-1, 1]) {
    const spreader = mesh(new THREE.BoxGeometry(0.075, 0.004, 0.006), COLOURS.metal);
    spreader.position.set(side * 0.038, MAST_FOOT + MAST_HEIGHT * 0.52, MAST_Z);
    spreader.rotation.z = side * -0.12;
    root.add(spreader);
  }
  root.add(rod([0, MASTHEAD - 0.01, MAST_Z], [0, 0.1, -0.48], 0.0016, COLOURS.metal));

  // A burgee at the masthead. It is a fixed shape: a frame of the film is a pure
  // function of the film's time, and a flag that flapped would have to read a
  // clock of its own.
  const burgee = new THREE.Mesh(new THREE.BufferGeometry(), sailMaterial(COLOURS.burgee));
  burgee.geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, MASTHEAD, MAST_Z, 0, MASTHEAD - 0.03, MAST_Z, 0.01, MASTHEAD - 0.012, MAST_Z - 0.075],
      3
    )
  );
  burgee.geometry.computeVertexNormals();
  root.add(burgee);

  // The mainsail turns about the mast, and the boom goes with it.
  const mainPivot = new THREE.Group();
  mainPivot.position.set(0, MAST_FOOT, MAST_Z);
  const boom = mesh(new THREE.CylinderGeometry(0.006, 0.006, MAST_Z - BOOM_Z, 8), COLOURS.metal);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, BOOM_Y - MAST_FOOT, -(MAST_Z - BOOM_Z) / 2);
  outline(boom, 0.002);
  mainPivot.add(boom);

  const mainCorners = [
    [0, BOOM_Y - MAST_FOOT + 0.008, 0],
    [0, MASTHEAD - MAST_FOOT - 0.012, 0],
    [0, BOOM_Y - MAST_FOOT + 0.014, BOOM_Z - MAST_Z]
  ];
  const mainShape = { camber: 0.034, roach: 0.055 };
  const mainsail = new THREE.Mesh(sailGeometry(mainCorners, mainShape), sailMaterial());
  mainPivot.add(mainsail);
  const mainBand = new THREE.Mesh(
    sailBandGeometry(mainCorners, mainShape, 0.16, 0.26),
    sailMaterial(COLOURS.sailBand, {
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3
    })
  );
  mainsail.add(mainBand);
  root.add(mainPivot);

  // The jib is fixed at the bow and the masthead; only its clew swings, so it is
  // rebuilt when the angle changes, and the boat's own frame stays put.
  const jibClewLength = 0.32;
  const jib = new THREE.Mesh(new THREE.BufferGeometry(), sailMaterial());
  root.add(jib);
  root.add(rod(FORESTAY_TACK, FORESTAY_HEAD, 0.0016, COLOURS.metal));

  let lastAngle = null;
  function trimJib(angle) {
    if (lastAngle !== null && Math.abs(angle - lastAngle) < 1e-4) {
      return;
    }
    lastAngle = angle;
    const clew = [
      -Math.sin(angle) * jibClewLength,
      FORESTAY_TACK[1] + 0.035,
      FORESTAY_TACK[2] - Math.cos(angle) * jibClewLength
    ];
    jib.geometry.dispose();
    // Bellying to leeward, the same side as the boom.
    jib.geometry = sailGeometry([FORESTAY_TACK, FORESTAY_HEAD, clew], {
      camber: -Math.sign(angle || 1) * 0.026,
      roach: 0.018
    });
  }
  trimJib(0);

  // A tiller, and a crew on the weather rail: the one thing that tells the eye
  // how big the boat is meant to be.
  const tiller = mesh(new THREE.BoxGeometry(0.008, 0.008, 0.16), COLOURS.deck);
  tiller.position.set(0, wellTop - 0.004, WELL.aft + 0.075);
  tiller.rotation.x = -0.14;
  root.add(tiller);

  const crew = new THREE.Group();
  const torso = mesh(new THREE.CylinderGeometry(0.019, 0.027, 0.05, 10), COLOURS.crew);
  torso.position.y = 0.025;
  outline(torso, 0.0025);
  crew.add(torso);
  const head = mesh(new THREE.SphereGeometry(0.017, 12, 10), COLOURS.skin);
  head.position.y = 0.062;
  outline(head, 0.0025);
  crew.add(head);
  crew.position.set(0, deckLevel(-0.26) - 0.006, -0.26);
  root.add(crew);

  const crewOffset = WELL.halfWidth + 0.032;

  function update(pose) {
    mainPivot.rotation.y = pose.sail;
    // The cloth bellies to leeward: the side the boom is on.
    mainsail.scale.x = pose.sail <= 0 ? 1 : -1;
    // The crew sit up on the weather rail, which is the other one.
    crew.position.x = pose.sail <= 0 ? -crewOffset : crewOffset;
    trimJib(pose.sail * 0.8);
  }

  function dispose() {
    root.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
  }

  return { root, update, dispose };
}

// The crew's model, sized to one unit long, its lowest point just under the
// waterline and its middle on the origin. Its bow must be towards +z with y up
// — the glTF convention — because nothing else says which end is the front.
export function normaliseCustomModel(scene) {
  const holder = new THREE.Group();
  holder.add(scene);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const length = Math.max(size.x, size.z, 1e-6);
  const scale = HULL_LENGTH / length;
  scene.position.set(-centre.x, -box.min.y, -centre.z);
  holder.scale.setScalar(scale);
  // Its keel below the waterline, its topsides above.
  holder.position.y = -DRAUGHT;
  const wrapper = new THREE.Group();
  wrapper.add(holder);
  return wrapper;
}

// The sails a crew's model has, by the names of its nodes: what the boat will
// trim, as `[{ node, role }]`.
export function customSails(scene) {
  return findSails(scene);
}

export function createCustomBoat(template) {
  const root = template.clone(true);
  // Each sail turns about the vertical axis through its own origin, from where the
  // model has it at rest: the crew put the origin on the mast (or the forestay).
  const sails = customSails(root).map(({ node, role }) => ({
    node,
    factor: SAIL_ROLES[role].factor,
    rest: node.rotation.y
  }));
  return {
    root,
    update(pose) {
      for (const { node, factor, rest } of sails) {
        node.rotation.y = rest + pose.sail * factor;
      }
    },
    dispose() {}
  };
}

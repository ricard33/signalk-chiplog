// What the 3D animation takes from three.js, and nothing else: scripts/vendor.js
// bundles this file into public/vendor/three.min.mjs, so the browser gets one
// small self-contained module rather than the library's split build, whose
// add-ons import the bare specifier 'three' — which a webapp with no build step
// and no import map cannot resolve. Listing the names is also what lets the
// bundler drop the rest of the library.
//
// Add a name here when renderer3d.mjs or boat-model.mjs starts to use it.
export {
  BackSide,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  PerspectiveCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer
} from 'three';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

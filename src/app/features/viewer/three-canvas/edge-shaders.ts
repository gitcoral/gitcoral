// Vertex and fragment shaders for connector lines rendered as screen-space capsules.
// Each segment is a quad (2 triangles); the fragment shader clips corners to rounded ends
// using a capsule SDF.

export const EDGE_VERT = /* glsl */ `
  attribute vec3  aStart;   // world-space segment start
  attribute vec3  aEnd;     // world-space segment end
  attribute vec3  aColor;
  attribute float aAlpha;
  attribute float aWidth;   // world units
  attribute float aIsEnd;   // 0 = start side, 1 = end side
  attribute float aSide;    // -1 or +1 (left / right of direction)

  varying vec3  vColor;
  varying float vAlpha;
  varying float vU;       // screen-px along segment axis (0 = segment start)
  varying float vV;       // screen-px across segment axis (0 = centreline)
  varying float vSegLen;  // segment length in screen px
  varying float vHalfW;   // half-width in screen px

  uniform vec2 uResolution;  // canvas size in CSS pixels

  void main() {
    vec4 mvS = modelViewMatrix * vec4(aStart, 1.0);
    vec4 mvE = modelViewMatrix * vec4(aEnd,   1.0);
    vec4 clipS = projectionMatrix * mvS;
    vec4 clipE = projectionMatrix * mvE;

    if (clipS.w <= 0.0 || clipE.w <= 0.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // clip out
      return;
    }

    // NDC → "screen px" (Y-up, centred at origin) — both axes are isotropic CSS pixels
    vec2 sS = (clipS.xy / clipS.w) * uResolution * 0.5;
    vec2 sE = (clipE.xy / clipE.w) * uResolution * 0.5;

    vec2  dir  = sE - sS;
    float len  = length(dir);
    vec2  dirN = len > 0.001 ? dir / len : vec2(1.0, 0.0);
    vec2  perpN = vec2(-dirN.y, dirN.x);

    // Half-width in CSS px via perspective (world units → screen using average eye depth)
    float eyeD  = mix(-mvS.z, -mvE.z, 0.5);
    float halfW = max(aWidth * 0.5 * projectionMatrix[1][1] * uResolution.y * 0.5 / eyeD, 0.5);

    // Extend each end of the quad by halfW to accommodate the rounded caps
    float capDir = aIsEnd > 0.5 ? 1.0 : -1.0;
    vec2  base   = aIsEnd > 0.5 ? sE : sS;
    vec2  offset = dirN * (capDir * halfW) + perpN * (aSide * halfW);

    // Convert back to NDC; use average clip-w so all 4 verts share the same w →
    // varyings interpolate linearly in screen space (perspective-correct with equal w)
    float avgW = mix(clipS.w, clipE.w, 0.5);
    float avgZ = mix(clipS.z / clipS.w, clipE.z / clipE.w, 0.5);
    vec2  finalNDC = (base + offset) / (uResolution * 0.5);
    gl_Position = vec4(finalNDC * avgW, avgZ * avgW, avgW);

    // Local px coords for the capsule SDF in the fragment shader
    vU      = aIsEnd > 0.5 ? len + halfW : -halfW;
    vV      = aSide * halfW;
    vSegLen = len;
    vHalfW  = halfW;

    vColor = aColor;
    vAlpha = aAlpha;
  }
`;

export const EDGE_FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vAlpha;
  varying float vU;
  varying float vV;
  varying float vSegLen;
  varying float vHalfW;

  void main() {
    if (vAlpha <= 0.0) discard;

    // Capsule SDF: segment from (0,0) to (vSegLen,0) with radius vHalfW
    float cu = clamp(vU, 0.0, vSegLen);
    float d  = length(vec2(vU - cu, vV));
    float a  = 1.0 - smoothstep(max(vHalfW - 1.0, 0.0), vHalfW, d);
    if (a <= 0.0) discard;

    gl_FragColor = vec4(vColor, vAlpha * a);
    #include <colorspace_fragment>
  }
`;

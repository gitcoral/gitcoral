// Vertex and fragment shaders for circular points with per-vertex size and colour.
// Two-pass rendering: ghost pass (uPass=0, depthTest:false) and focused pass (uPass=1, depthTest:true).
// Folders render as flat 2D rings; files render as lit sphere impostors.

export const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3  aColor;
  attribute float aIsFolder;
  attribute float aAlpha;
  attribute float aFocused;
  varying   vec3  vColor;
  varying   float vIsFolder;
  varying   float vAlpha;
  varying   float vFocused;
  uniform   float uPixelRatio;
  uniform   float uViewportH;

  void main() {
    vColor    = aColor;
    vIsFolder = aIsFolder;
    vAlpha    = aAlpha;
    vFocused  = aFocused;
    vec4 mv      = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * projectionMatrix[1][1] * uViewportH * 0.5 * uPixelRatio / -mv.z;
    gl_Position  = projectionMatrix * mv;
  }
`;

export const FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vIsFolder;
  varying float vAlpha;
  varying float vFocused;
  uniform float uPass;

  void main() {
    if (vAlpha <= 0.0) discard;
    if (uPass > 0.5 && vFocused < 0.5) discard;
    if (uPass < 0.5 && vFocused > 0.5) discard;

    vec2  uv = gl_PointCoord - vec2(0.5);
    float r  = dot(uv, uv);
    if (r > 0.25) discard;
    if (vIsFolder > 0.5 && r < 0.075) discard;

    vec3 lit;
    if (vIsFolder > 0.5) {
      lit = vColor;
    } else {
      // ldir = normalize(0.6, 0.8, 0.8), hdir = normalize(ldir + vec3(0,0,1))
      const vec3 ldir = vec3(0.4685, 0.6247, 0.6247);
      const vec3 hdir = vec3(0.2599, 0.3466, 0.9013);
      float z    = sqrt(0.25 - r);
      vec3  norm = normalize(vec3(uv, z));
      float diff = max(dot(norm, ldir), 0.0);
      float s = max(dot(hdir, norm), 0.0);
      s = s * s; s = s * s; s = s * s; s = s * s; s = s * s; // s^32
      float spec = s * 0.4;
      lit = vColor * (0.25 + diff) + vec3(spec);
    }

    gl_FragColor = vec4(lit, vAlpha);
    #include <colorspace_fragment>
  }
`;

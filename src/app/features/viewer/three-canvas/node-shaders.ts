// Vertex and fragment shaders for circular points with per-vertex size and colour.
// Folders render as flat 2D rings; files render as sphere impostors.

export const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3  aColor;
  attribute float aIsFolder;
  attribute float aAlpha;
  varying   vec3  vColor;
  varying   float vIsFolder;
  varying   float vAlpha;
  uniform   float uPixelRatio;

  void main() {
    vColor    = aColor;
    vIsFolder = aIsFolder;
    vAlpha    = aAlpha;
    vec4 mv      = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
    gl_Position  = projectionMatrix * mv;
  }
`;

export const FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vIsFolder;
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.0) discard;
    vec2  uv = gl_PointCoord - vec2(0.5);
    float r  = dot(uv, uv);
    if (r > 0.25) discard;
    if (vIsFolder > 0.5 && r < 0.075) discard; // ring centre

    // Dimmed fragments write far depth so connectors (renderOrder 1) are not occluded.
    gl_FragDepth = vAlpha < 1.0 ? 1.0 : gl_FragCoord.z;

    if (vIsFolder > 0.5) {
      gl_FragColor = vec4(vColor, vAlpha);
    } else {
      // Sphere impostor: reconstruct hemisphere normal from point coord
      float z      = sqrt(0.25 - r);
      vec3  normal = normalize(vec3(uv, z));

      vec3  light   = normalize(vec3(0.6, 0.8, 0.8));
      float diffuse = max(dot(normal, light), 0.0);
      float ambient = 0.25;

      vec3  halfVec = normalize(light + vec3(0.0, 0.0, 1.0));
      float spec    = pow(max(dot(normal, halfVec), 0.0), 32.0) * 0.4;

      vec3 lit = vColor * (ambient + diffuse) + vec3(spec);
      gl_FragColor = vec4(lit, vAlpha);
    }
    #include <colorspace_fragment>
  }
`;

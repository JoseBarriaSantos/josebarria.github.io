// ----- Blueprint grid shader background -----
// An original WebGL implementation of a "blueprint grid" look: navy backdrop,
// fine minor gridlines, brighter major lines, a slow glow sweep and a vignette.
// Same framework-free three.js pattern as hero.js. Mounts on <canvas id="blueprint-grid">.
import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("blueprint-grid");

if (canvas) {
  const vertexShader = `
    attribute vec3 position;
    void main() {
      gl_Position = vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    precision highp float;
    uniform vec2 resolution;
    uniform float time;

    // Distance to the nearest gridline (0 on a line) for a given cell size.
    float gridLine(vec2 p, float scale, float halfWidth) {
      vec2 g = abs(fract(p * scale - 0.5) - 0.5) / scale;
      float d = min(g.x, g.y);
      return 1.0 - smoothstep(0.0, halfWidth, d);
    }

    void main() {
      // Aspect-correct coords, y as the unit axis.
      vec2 uv = (gl_FragCoord.xy - 0.5 * resolution) / resolution.y;

      // Slow drift so it feels alive.
      vec2 p = uv + vec2(time * 0.015, time * 0.008);

      vec3 bg      = vec3(0.02, 0.05, 0.13);   // deep navy
      vec3 lineCol = vec3(0.55, 0.78, 1.0);    // blueprint light-blue

      // Minor grid (12 cells across) and major grid (every 4 minor cells).
      float minor = gridLine(p, 12.0, 0.012);
      float major = gridLine(p, 3.0, 0.010);

      // Diagonal glow sweep passing over the grid.
      float sweep = 0.5 + 0.5 * sin((uv.x + uv.y) * 2.2 - time * 0.6);

      float intensity = 0.8;   // toned down 20% for text readability
      vec3 col = bg;
      col += minor * (0.10 + 0.10 * sweep) * lineCol * intensity;
      col += major * (0.32 + 0.18 * sweep) * lineCol * intensity;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);

  const uniforms = {
    resolution: { value: [1, 1] },
    time: { value: 0.0 },
  };

  const position = [
    -1.0, -1.0, 0.0,  1.0, -1.0, 0.0, -1.0, 1.0, 0.0,
     1.0, -1.0, 0.0, -1.0,  1.0, 0.0,  1.0, 1.0, 0.0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(position), 3));

  const material = new THREE.RawShaderMaterial({ vertexShader, fragmentShader, uniforms, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(geometry, material));

  const handleResize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    uniforms.resolution.value = [w * dpr, h * dpr];
  };

  const render = () => renderer.render(scene, camera);

  let animationId = null;
  let running = false;
  const animate = () => {
    uniforms.time.value += 0.016;
    render();
    animationId = requestAnimationFrame(animate);
  };
  const start = () => { if (!running && !reduceMotion) { running = true; animate(); } };
  const stop = () => { running = false; if (animationId) cancelAnimationFrame(animationId); animationId = null; };

  window.addEventListener("resize", handleResize);
  handleResize();

  if (reduceMotion) {
    render();
  } else if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? start() : stop();
    }, { threshold: 0 }).observe(canvas);
  } else {
    start();
  }
}

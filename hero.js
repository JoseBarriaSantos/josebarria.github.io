// ----- WebGL shader hero background -----
// Vanilla-JS port of the React <WebGLShader/> component.
// three.js is framework-agnostic, so the shader logic ports 1:1;
// only the React useEffect lifecycle is replaced by plain init/cleanup.
import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("hero-shader");

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
    uniform float xScale;
    uniform float yScale;
    uniform float distortion;

    void main() {
      vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);

      float d = length(p) * distortion;

      float rx = p.x * (1.0 + d);
      float gx = p.x;
      float bx = p.x * (1.0 - d);

      float r = 0.05 / abs(p.y + sin((rx + time) * xScale) * yScale);
      float g = 0.05 / abs(p.y + sin((gx + time) * xScale) * yScale);
      float b = 0.05 / abs(p.y + sin((bx + time) * xScale) * yScale);

      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(new THREE.Color(0x000000));

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);

  const uniforms = {
    resolution: { value: [1, 1] },
    time: { value: 0.0 },
    xScale: { value: 1.0 },
    yScale: { value: 0.5 },
    distortion: { value: 0.05 },
  };

  const position = [
    -1.0, -1.0, 0.0,
     1.0, -1.0, 0.0,
    -1.0,  1.0, 0.0,
     1.0, -1.0, 0.0,
    -1.0,  1.0, 0.0,
     1.0,  1.0, 0.0,
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(position), 3)
  );

  const material = new THREE.RawShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Size to the canvas element (contained hero), not the whole window.
  const handleResize = () => {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    // gl_FragCoord is in device pixels, so match the drawing-buffer size.
    uniforms.resolution.value = [width * dpr, height * dpr];
  };

  const render = () => {
    renderer.render(scene, camera);
  };

  let animationId = null;
  let running = false;

  const animate = () => {
    uniforms.time.value += 0.01;
    render();
    animationId = requestAnimationFrame(animate);
  };

  const start = () => {
    if (running || reduceMotion) return;
    running = true;
    animate();
  };

  const stop = () => {
    running = false;
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;
  };

  window.addEventListener("resize", handleResize);
  handleResize();

  if (reduceMotion) {
    // Draw a single static frame instead of animating.
    render();
  } else {
    // Only animate while the hero is on screen (saves battery/GPU).
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) start();
            else stop();
          }
        },
        { threshold: 0 }
      );
      io.observe(canvas);
    } else {
      start();
    }
  }
}

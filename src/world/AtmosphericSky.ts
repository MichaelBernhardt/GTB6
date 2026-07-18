import * as THREE from 'three';

export interface SkyMood {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sunColor: THREE.Color;
  sunDirection: THREE.Vector3;
  moonDirection: THREE.Vector3;
  night: number;
  blackout: number;
  time: number;
}

export interface AtmosphericSkyHandle {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  material: THREE.ShaderMaterial;
  setMood(mood: SkyMood): void;
  setQuality(quality: 'low' | 'medium' | 'high'): void;
}

export const SKY_DOME_RADIUS = 7000;

const vertexShader = /* glsl */`
  varying vec3 vSkyDirection;

  void main() {
    vSkyDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function fragmentShader(cloudOctaves: number): string {
  return /* glsl */`
    uniform vec3 uZenithColor;
    uniform vec3 uHorizonColor;
    uniform vec3 uSunColor;
    uniform vec3 uSunDirection;
    uniform vec3 uMoonDirection;
    uniform float uNight;
    uniform float uBlackout;
    uniform float uTime;

    varying vec3 vSkyDirection;

    const float PI = 3.14159265359;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float valueNoise(vec2 p) {
      vec2 cell = floor(p);
      vec2 local = fract(p);
      local = local * local * (3.0 - 2.0 * local);
      float a = hash21(cell);
      float b = hash21(cell + vec2(1.0, 0.0));
      float c = hash21(cell + vec2(0.0, 1.0));
      float d = hash21(cell + vec2(1.0, 1.0));
      return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
    }

    float cloudNoise(vec2 p) {
      float value = 0.0;
      float amplitude = 0.53;
      mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
      for (int octave = 0; octave < ${cloudOctaves}; octave++) {
        value += valueNoise(p) * amplitude;
        p = turn * p * 2.03 + 9.7;
        amplitude *= 0.5;
      }
      return value;
    }

    vec2 sphericalUv(vec3 direction) {
      return vec2(
        atan(direction.z, direction.x) / (2.0 * PI) + 0.5,
        acos(clamp(direction.y, -1.0, 1.0)) / PI
      );
    }

    float starField(vec3 direction, out float starTemperature) {
      vec2 grid = sphericalUv(direction) * vec2(480.0, 240.0);
      vec2 cell = floor(grid);
      vec2 local = fract(grid);
      float seed = hash21(cell);
      vec2 point = vec2(hash21(cell + 17.1), hash21(cell + 63.7));
      float radius = mix(0.018, 0.050, hash21(cell + 91.4));
      float distanceToStar = length(local - point);
      float edge = max(fwidth(distanceToStar) * 0.72, 0.003);
      float star = 1.0 - smoothstep(radius, radius + edge, distanceToStar);
      starTemperature = hash21(cell + 141.8);
      return star * step(0.991, seed) * mix(0.55, 1.0, hash21(cell + 201.3));
    }

    void main() {
      vec3 direction = normalize(vSkyDirection);
      float aboveHorizon = smoothstep(-0.03, 0.12, direction.y);
      float altitude = clamp(direction.y, 0.0, 1.0);
      float zenithBlend = smoothstep(0.0, 0.62, altitude);
      float zenithLuma = dot(uZenithColor, vec3(0.2126, 0.7152, 0.0722));
      vec3 richZenith = mix(vec3(zenithLuma), uZenithColor, 1.16);
      vec3 color = mix(uHorizonColor, max(richZenith, 0.0), zenithBlend);

      // A warm, dense atmospheric band gives the city a readable horizon instead of a flat clear color.
      float horizonBand = pow(1.0 - altitude, 7.0) * aboveHorizon;
      color = mix(color, uHorizonColor * 1.08, horizonBand * 0.58);

      float sunDot = max(dot(direction, normalize(uSunDirection)), 0.0);
      float sunAbove = smoothstep(-0.11, 0.04, uSunDirection.y);
      float broadSunGlow = pow(sunDot, 18.0) * 0.22;
      float tightSunGlow = pow(sunDot, 150.0) * 0.42;
      color += uSunColor * (broadSunGlow + tightSunGlow) * sunAbove * (1.0 - uNight * 0.85);

      float moonDot = max(dot(direction, normalize(uMoonDirection)), 0.0);
      float moonAbove = smoothstep(-0.08, 0.03, uMoonDirection.y);
      color += vec3(0.42, 0.52, 0.72) * pow(moonDot, 85.0) * 0.24 * moonAbove * uNight;

      // The Milky Way is deliberately subtle in powered areas and emerges during load shedding.
      float starVisibility = uNight * uNight * aboveHorizon * mix(0.62, 1.25, uBlackout);
      vec3 galacticNormal = normalize(vec3(0.31, 0.78, -0.54));
      float galaxyBand = pow(1.0 - abs(dot(direction, galacticNormal)), 7.0);
      float galaxyTexture = valueNoise(sphericalUv(direction) * vec2(11.0, 7.0) + 4.3);
      color += vec3(0.20, 0.25, 0.38) * galaxyBand * (0.25 + galaxyTexture * 0.75) * starVisibility * 0.20;

      float starTemperature;
      float star = starField(direction, starTemperature);
      float twinkle = 0.78 + 0.22 * sin(uTime * 1.7 + starTemperature * 31.0);
      vec3 coolStar = vec3(0.64, 0.76, 1.0);
      vec3 warmStar = vec3(1.0, 0.82, 0.62);
      color += mix(coolStar, warmStar, starTemperature) * star * twinkle * starVisibility;

      // A wind-driven cloud sheet adds large-scale shape while staying cheap enough for the full-screen dome.
      vec2 cloudPlane = direction.xz / max(direction.y + 0.13, 0.15);
      vec2 wind = vec2(uTime * 0.010, uTime * 0.0025);
      float cloudShape = cloudNoise(cloudPlane * 1.18 + wind);
      float cloud = smoothstep(0.47, 0.70, cloudShape) * smoothstep(0.025, 0.20, direction.y);
      float sunFacing = max(dot(normalize(vec3(direction.x, 0.32, direction.z)), normalize(uSunDirection)), 0.0);
      vec3 dayCloud = mix(uHorizonColor, vec3(1.0), 0.68) * (0.74 + sunFacing * 0.24);
      dayCloud = mix(dayCloud, uSunColor, sunFacing * 0.18);
      dayCloud *= mix(0.72, 1.0, smoothstep(0.52, 0.76, cloudShape));
      vec3 nightCloud = mix(uZenithColor, uHorizonColor, 0.65) * mix(0.60, 0.34, uBlackout);
      vec3 cloudColor = mix(dayCloud, nightCloud, uNight);
      float cloudCore = smoothstep(0.58, 0.76, cloudShape);
      color *= 1.0 - cloudCore * mix(0.055, 0.12, uNight);
      float cloudOpacity = cloud * mix(0.52, 0.25, uNight) * mix(1.0, 0.64, uBlackout);
      color = mix(color, cloudColor, cloudOpacity);

      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;
}

/** A player-centred procedural dome: one draw call, no texture downloads, and no visible edge at the horizon. */
export function createAtmosphericSky(quality: 'low' | 'medium' | 'high'): AtmosphericSkyHandle {
  const uniforms: Record<string, THREE.IUniform> = {
    uZenithColor: { value: new THREE.Color(0x6fa8dd) },
    uHorizonColor: { value: new THREE.Color(0xc4b48c) },
    uSunColor: { value: new THREE.Color(0xffd9a0) },
    uSunDirection: { value: new THREE.Vector3(0.6, 0.7, 0.4).normalize() },
    uMoonDirection: { value: new THREE.Vector3(-0.6, -0.7, -0.4).normalize() },
    uNight: { value: 0 },
    uBlackout: { value: 0 },
    uTime: { value: 0 },
  };
  const octavesFor = (tier: 'low' | 'medium' | 'high'): number => tier === 'low' ? 2 : tier === 'medium' ? 3 : 4;
  let cloudOctaves = octavesFor(quality);
  const material = new THREE.ShaderMaterial({
    name: 'Atmospheric Sky Material',
    uniforms,
    vertexShader,
    fragmentShader: fragmentShader(cloudOctaves),
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_DOME_RADIUS, 32, 18), material);
  mesh.name = 'Atmospheric Sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;

  return {
    mesh,
    material,
    setMood(mood: SkyMood): void {
      (uniforms.uZenithColor!.value as THREE.Color).copy(mood.zenith);
      (uniforms.uHorizonColor!.value as THREE.Color).copy(mood.horizon);
      (uniforms.uSunColor!.value as THREE.Color).copy(mood.sunColor);
      (uniforms.uSunDirection!.value as THREE.Vector3).copy(mood.sunDirection);
      (uniforms.uMoonDirection!.value as THREE.Vector3).copy(mood.moonDirection);
      uniforms.uNight!.value = mood.night;
      uniforms.uBlackout!.value = mood.blackout;
      uniforms.uTime!.value = mood.time;
    },
    setQuality(tier: 'low' | 'medium' | 'high'): void {
      const nextOctaves = octavesFor(tier);
      if (nextOctaves === cloudOctaves) return;
      cloudOctaves = nextOctaves;
      material.fragmentShader = fragmentShader(cloudOctaves);
      material.needsUpdate = true;
    },
  };
}

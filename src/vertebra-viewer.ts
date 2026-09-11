import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import Npyjs from "npyjs";


type NumericArrayLike = {
  readonly length: number;
  readonly [index: number]: number | bigint;
};


type NpyResult = {
  data: NumericArrayLike;
  shape: number[];
};


type GeneratorManifest = {
  formatVersion: number;
  level: string;
  numPcs: number;
  numVertices: number;
  numFaces: number;
  numFeatures: number;
  mean: string;
  basis: string;
  scoreStds: string;
  faces: string;
  sliderMinimum: number;
  sliderMaximum: number;
  sliderStep: number;
  pcIndexing: string;
};


async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: HTTP ${response.status}`,
    );
  }

  return response.json() as Promise<T>;
}


async function fetchNpy(url: string): Promise<NpyResult> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: HTTP ${response.status}`,
    );
  }

  const buffer = await response.arrayBuffer();
  const npy = new Npyjs();
  const parsed = await npy.parse(buffer);

  if (parsed.data instanceof DataView) {
    throw new Error(`NPY payload from ${url} unexpectedly contains a DataView.`);
  }

  return {
    data: parsed.data as unknown as NumericArrayLike,
    shape: Array.from(parsed.shape, Number),
  };
}


function toFloat32(data: NumericArrayLike): Float32Array {
  const result: Float32Array = new Float32Array(data.length);

  for (let index = 0; index < data.length; index += 1) {
    result[index] = Number(data[index]);
  }

  return result;
}


function createIndexArray(
  data: NumericArrayLike,
  vertexCount: number,
): Uint16Array | Uint32Array {
  let maximum = 0;
  const values = new Array<number>(data.length);

  for (let index = 0; index < data.length; index += 1) {
    const value = Number(data[index]);

    if (!Number.isInteger(value)) {
      throw new Error(
        `Face index ${index} is not an integer: ${value}`,
      );
    }

    if (value < 0 || value >= vertexCount) {
      throw new Error(
        `Face index ${value} is outside vertex range 0..${vertexCount - 1}.`,
      );
    }

    values[index] = value;
    maximum = Math.max(maximum, value);
  }

  if (maximum <= 65_535) {
    return Uint16Array.from(values);
  }

  return Uint32Array.from(values);
}


const PCA_SLIDER_MINIMUM = -2;
const PCA_SLIDER_MAXIMUM = 2;
const PCA_ANIMATION_AMPLITUDE = 1.5;


export class VertebraViewer {
  private readonly viewerElement: HTMLElement;
  private readonly slidersElement: HTMLElement;
  private readonly statusElement: HTMLElement;
  private readonly titleElement: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

  private readonly resizeObserver: ResizeObserver;

  private geometry: THREE.BufferGeometry | null = null;
  private mesh: THREE.Mesh | null = null;

  private mean: Float32Array = new Float32Array();
  private basis: Float32Array = new Float32Array();
  private scoreStds: Float32Array = new Float32Array();
  private zScores: Float32Array = new Float32Array();

  private numPcs = 0;
  private numFeatures = 0;
  private currentLevel: string | null = null;
  private sliderMinimum = PCA_SLIDER_MINIMUM;
  private sliderMaximum = PCA_SLIDER_MAXIMUM;
  private currentTheme: "light" | "dark" = "light";

  private reconstructionScheduled = false;
  private loadGeneration = 0;
  private animationFrame: number | null = null;
  private referencePositions: Float32Array | null = null;
  private readonly metricsCallback?: (metrics: { surfaceArea: number; volume: number; mahalanobis?: number }) => void;
  private readonly animationStateCallback?: (isAnimating: boolean) => void;


  public constructor(
    viewerElement: HTMLElement,
    slidersElement: HTMLElement,
    statusElement: HTMLElement,
    titleElement: HTMLElement,
    metricsCallback?: (metrics: { surfaceArea: number; volume: number; mahalanobis?: number }) => void,
    animationStateCallback?: (isAnimating: boolean) => void,
  ) {
    this.viewerElement = viewerElement;
    this.slidersElement = slidersElement;
    this.statusElement = statusElement;
    this.titleElement = titleElement;
    this.metricsCallback = metricsCallback;
    this.animationStateCallback = animationStateCallback;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf1f5fa);

    this.camera = new THREE.PerspectiveCamera(
      45,
      1,
      0.01,
      10_000,
    );

    this.camera.up.set(0, 1, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });

    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, 2),
    );

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.viewerElement.appendChild(
      this.renderer.domElement,
    );

    this.controls = new OrbitControls(
      this.camera,
      this.renderer.domElement,
    );

    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.addLights();

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });

    this.resizeObserver.observe(this.viewerElement);

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });

    this.resize();
  }


  private addLights(): void {
    const hemisphereLight = new THREE.HemisphereLight(
      0xffffff,
      0x70809a,
      1.8,
    );

    this.scene.add(hemisphereLight);

    const frontLight = new THREE.DirectionalLight(
      0xffffff,
      3.4,
    );

    frontLight.position.set(1.5, 2.5, 3.5);
    this.scene.add(frontLight);

    const sideLight = new THREE.DirectionalLight(
      0xffffff,
      1.7,
    );

    sideLight.position.set(-3, 1.5, -1);
    this.scene.add(sideLight);

    const rimLight = new THREE.DirectionalLight(
      0x9cc2ff,
      1.1,
    );

    rimLight.position.set(0, -1, -4);
    this.scene.add(rimLight);
  }


  private resize(): void {
    const width = Math.max(
      1,
      this.viewerElement.clientWidth,
    );

    const height = Math.max(
      1,
      this.viewerElement.clientHeight,
    );

    this.renderer.setSize(
      width,
      height,
      false,
    );

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }


  public async load(manifestPath: string): Promise<void> {
    this.stopAnimation();
    const currentGeneration = ++this.loadGeneration;

    this.setStatus("Loading generator...");
    this.slidersElement.replaceChildren();

    const manifestUrl = new URL(
      manifestPath,
      window.location.href,
    );

    const manifest = await fetchJson<GeneratorManifest>(
      manifestUrl.toString(),
    );

    if (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) {
      throw new Error(
        `Unsupported generator format version: ${manifest.formatVersion}`,
      );
    }

    const resolveAsset = (filename: string): string => {
      return new URL(filename, manifestUrl).toString();
    };

    const [meanNpy, basisNpy, stdsNpy, facesNpy] =
      await Promise.all([
        fetchNpy(resolveAsset(manifest.mean)),
        fetchNpy(resolveAsset(manifest.basis)),
        fetchNpy(resolveAsset(manifest.scoreStds)),
        fetchNpy(resolveAsset(manifest.faces)),
      ]);

    // Ignore an older load if another dataset was selected meanwhile.
    if (currentGeneration !== this.loadGeneration) {
      return;
    }

    this.validateArrays(
      manifest,
      meanNpy,
      basisNpy,
      stdsNpy,
      facesNpy,
    );

    this.mean = toFloat32(meanNpy.data);
    this.basis = toFloat32(basisNpy.data);
    this.scoreStds = toFloat32(stdsNpy.data);

    this.numPcs = manifest.numPcs;
    this.numFeatures = manifest.numFeatures;
    this.currentLevel = manifest.level;
    // The browser generator deliberately exposes a conservative, fixed
    // range, independent of older manifest defaults.
    this.sliderMinimum = PCA_SLIDER_MINIMUM;
    this.sliderMaximum = PCA_SLIDER_MAXIMUM;
    this.zScores = new Float32Array(this.numPcs);

    this.createGeometry(
      facesNpy.data,
      manifest.numVertices,
    );

    this.createSliders(manifest);
    this.reconstruct();
    this.fitCamera();

    this.titleElement.textContent =
      `Generated vertebra — ${manifest.level}`;

    this.setStatus(
      `${manifest.numPcs} PCA components, ` +
      `${manifest.numVertices.toLocaleString()} vertices, ` +
      `${manifest.numFaces.toLocaleString()} faces.`,
    );
  }


  private validateArrays(
    manifest: GeneratorManifest,
    meanNpy: NpyResult,
    basisNpy: NpyResult,
    stdsNpy: NpyResult,
    facesNpy: NpyResult,
  ): void {
    if (
      meanNpy.shape.length !== 1 ||
      meanNpy.shape[0] !== manifest.numFeatures
    ) {
      throw new Error(
        "Invalid generator mean shape. Expected " +
        `[${manifest.numFeatures}], got ` +
        `[${meanNpy.shape.join(", ")}].`,
      );
    }

    if (
      basisNpy.shape.length !== 2 ||
      basisNpy.shape[0] !== manifest.numPcs ||
      basisNpy.shape[1] !== manifest.numFeatures
    ) {
      throw new Error(
        "Invalid generator basis shape. Expected " +
        `[${manifest.numPcs}, ${manifest.numFeatures}], got ` +
        `[${basisNpy.shape.join(", ")}].`,
      );
    }

    if (
      stdsNpy.shape.length !== 1 ||
      stdsNpy.shape[0] !== manifest.numPcs
    ) {
      throw new Error(
        "Invalid standard-deviation shape. Expected " +
        `[${manifest.numPcs}], got ` +
        `[${stdsNpy.shape.join(", ")}].`,
      );
    }

    if (
      !((facesNpy.shape.length === 1 && facesNpy.shape[0] === manifest.numFaces * 3) ||
        (facesNpy.shape.length === 2 && facesNpy.shape[0] === manifest.numFaces && facesNpy.shape[1] === 3))
    ) {
      throw new Error(
        "Invalid face index shape. Expected flat or 2D triangle indices, got " +
        `[${facesNpy.shape.join(", ")}].`,
      );
    }

    if (manifest.numFeatures !== manifest.numVertices * 3) {
      throw new Error(
        "Manifest is inconsistent: numFeatures must equal " +
        "numVertices × 3.",
      );
    }
  }


  private createGeometry(
    faceData: NumericArrayLike,
    vertexCount: number,
  ): void {
    this.disposeCurrentMesh();

    const positions = new Float32Array(this.mean);

    const geometry = new THREE.BufferGeometry();

    const positionAttribute = new THREE.BufferAttribute(
      positions,
      3,
    );

    positionAttribute.setUsage(
      THREE.DynamicDrawUsage,
    );

    geometry.setAttribute(
      "position",
      positionAttribute,
    );

    const indices = createIndexArray(
      faceData,
      vertexCount,
    );

    geometry.setIndex(
      new THREE.BufferAttribute(indices, 1),
    );

    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: 0xdbe6f4,
      roughness: 0.62,
      metalness: 0.015,
      side: THREE.DoubleSide,
    });

    this.applyMaterialTheme(material);

    const mesh = new THREE.Mesh(
      geometry,
      material,
    );

    this.geometry = geometry;
    this.mesh = mesh;

    this.scene.add(mesh);
  }


  private createSliders(
    manifest: GeneratorManifest,
  ): void {
    this.slidersElement.replaceChildren();

    for (
      let componentIndex = 0;
      componentIndex < this.numPcs;
      componentIndex += 1
    ) {
      const row = document.createElement("div");
      row.className = "pc-slider-row";

      const heading = document.createElement("div");
      heading.className = "pc-slider-heading";

      const label = document.createElement("label");
      label.textContent = `PC${componentIndex}`;

      const output = document.createElement("output");
      output.className = "pc-slider-value";
      output.value = "0.00 σ";
      output.textContent = "0.00 σ";

      const slider = document.createElement("input");

      slider.type = "range";
      slider.className = "form-range";
      slider.min = String(this.sliderMinimum);
      slider.max = String(this.sliderMaximum);
      slider.step = String(manifest.sliderStep);
      slider.value = "0";

      const sliderId = `vertebra-pc-${componentIndex}`;

      slider.id = sliderId;
      label.htmlFor = sliderId;

      slider.addEventListener("input", () => {
        this.stopAnimation();
        const value = Number(slider.value);

        this.zScores[componentIndex] = value;

        const formatted = `${value.toFixed(2)} σ`;

        output.value = formatted;
        output.textContent = formatted;

        this.scheduleReconstruction();
      });

      heading.append(label, output);
      row.append(heading, slider);
      this.slidersElement.appendChild(row);
    }
  }


  private scheduleReconstruction(): void {
    if (this.reconstructionScheduled) {
      return;
    }

    this.reconstructionScheduled = true;

    requestAnimationFrame(() => {
      this.reconstructionScheduled = false;
      this.reconstruct();
    });
  }


  private reconstruct(): void {
    if (
      this.geometry === null ||
      this.numFeatures === 0
    ) {
      return;
    }

    const positionAttribute =
      this.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;

    const positions =
      positionAttribute.array as Float32Array;

    // Start at inverse_transform(0).
    positions.set(this.mean);

    // Apply each PCA displacement:
    //
    // coefficient = z-score × PCA-score standard deviation
    //
    // vertices = mean + Σ coefficient × basis
    for (
      let componentIndex = 0;
      componentIndex < this.numPcs;
      componentIndex += 1
    ) {
      const coefficient =
        this.zScores[componentIndex] *
        this.scoreStds[componentIndex];

      if (coefficient === 0) {
        continue;
      }

      const basisOffset =
        componentIndex * this.numFeatures;

      for (
        let featureIndex = 0;
        featureIndex < this.numFeatures;
        featureIndex += 1
      ) {
        positions[featureIndex] +=
          coefficient *
          this.basis[basisOffset + featureIndex];
      }
    }

    positionAttribute.needsUpdate = true;

    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();

    this.emitMetrics();

    const normalAttribute =
      this.geometry.getAttribute("normal");

    if (normalAttribute !== undefined) {
      normalAttribute.needsUpdate = true;
    }
  }


  public getComponentCount(): number {
    return this.numPcs;
  }

  public getZScores(): number[] {
    return Array.from(this.zScores);
  }

  public setZScores(values: ArrayLike<number>, label?: string): void {
    this.stopAnimation();
    if (this.numPcs === 0) throw new Error("No mesh generator is loaded.");
    this.zScores.fill(0);
    for (let i = 0; i < Math.min(values.length, this.numPcs); i += 1) {
      const value = Number(values[i]);
      this.zScores[i] = Number.isFinite(value)
        ? Math.max(this.sliderMinimum, Math.min(this.sliderMaximum, value))
        : 0;
    }
    this.updateSliderControls(true);
    this.reconstruct();
    if (label) this.setStatus(label);
  }

  public randomise(maxSigma = PCA_SLIDER_MAXIMUM): void {
    const spare: number[] = [];
    const normal = (): number => {
      if (spare.length) return spare.pop()!;
      const u = Math.max(Math.random(), Number.EPSILON);
      const v = Math.random();
      const r = Math.sqrt(-2 * Math.log(u));
      spare.push(r * Math.sin(2 * Math.PI * v));
      return r * Math.cos(2 * Math.PI * v);
    };
    const values = Array.from({ length: this.numPcs }, () => Math.max(-maxSigma, Math.min(maxSigma, normal())));
    this.setZScores(values, "Generated a random plausible vertebra.");
  }

  public animatePc(componentIndex: number, durationMs = 5000): void {
    if (componentIndex < 0 || componentIndex >= this.numPcs) {
      throw new Error("PC index is out of range.");
    }

    this.stopAnimation();
    const start = performance.now();
    const amplitude = PCA_ANIMATION_AMPLITUDE;

    const tick = (now: number): void => {
      const phase = ((now - start) % durationMs) / durationMs;
      this.zScores[componentIndex] = amplitude * Math.sin(phase * Math.PI * 2);
      this.updateSliderControls(false);
      this.reconstruct();
      this.animationFrame = requestAnimationFrame(tick);
    };

    this.animationStateCallback?.(true);
    this.animationFrame = requestAnimationFrame(tick);
  }

  public isAnimating(): boolean {
    return this.animationFrame !== null;
  }

  public stopAnimation(): void {
    const wasAnimating = this.animationFrame !== null;

    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
    }

    this.animationFrame = null;

    if (wasAnimating) {
      this.animationStateCallback?.(false);
    }
  }

  public setReferenceZScores(values: ArrayLike<number> | null): void {
    this.stopAnimation();

    if (values === null) {
      this.referencePositions = null;
      if (this.geometry?.hasAttribute("color")) this.geometry.deleteAttribute("color");
      if (this.mesh?.material instanceof THREE.MeshStandardMaterial) {
        this.mesh.material.vertexColors = false;
        this.applyMaterialTheme(this.mesh.material);
      }
      return;
    }
    const z = new Float32Array(this.numPcs);
    for (let i = 0; i < Math.min(values.length, z.length); i += 1) z[i] = Number(values[i]);
    const positions = new Float32Array(this.mean);
    for (let pc = 0; pc < this.numPcs; pc += 1) {
      const coefficient = z[pc] * this.scoreStds[pc];
      const offset = pc * this.numFeatures;
      for (let f = 0; f < this.numFeatures; f += 1) positions[f] += coefficient * this.basis[offset + f];
    }
    this.referencePositions = positions;
    this.applyDifferenceHeatmap();
  }

  private applyDifferenceHeatmap(): void {
    if (!this.geometry || !this.mesh || !this.referencePositions) return;
    const positions = (this.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const colors = new Float32Array(positions.length);
    const distances = new Float32Array(positions.length / 3);
    let max = 0;
    for (let i = 0, v = 0; i < positions.length; i += 3, v += 1) {
      const dx = positions[i] - this.referencePositions[i];
      const dy = positions[i + 1] - this.referencePositions[i + 1];
      const dz = positions[i + 2] - this.referencePositions[i + 2];
      distances[v] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      max = Math.max(max, distances[v]);
    }
    const cold = new THREE.Color(0x2166ac), hot = new THREE.Color(0xb2182b);
    for (let v = 0; v < distances.length; v += 1) {
      const c = cold.clone().lerp(hot, max > 0 ? distances[v] / max : 0);
      colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
    }
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    material.vertexColors = true; material.needsUpdate = true;
  }

  public getMetrics(): { surfaceArea: number; volume: number } {
    if (!this.geometry) return { surfaceArea: 0, volume: 0 };
    const p = (this.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const idx = this.geometry.getIndex()?.array as ArrayLike<number> | undefined;
    let area = 0, signedVolume = 0;
    const count = idx ? idx.length : p.length / 3;
    for (let i = 0; i < count; i += 3) {
      const ia = idx ? Number(idx[i]) : i, ib = idx ? Number(idx[i + 1]) : i + 1, ic = idx ? Number(idx[i + 2]) : i + 2;
      const ax=p[ia*3], ay=p[ia*3+1], az=p[ia*3+2], bx=p[ib*3], by=p[ib*3+1], bz=p[ib*3+2], cx=p[ic*3], cy=p[ic*3+1], cz=p[ic*3+2];
      const abx=bx-ax, aby=by-ay, abz=bz-az, acx=cx-ax, acy=cy-ay, acz=cz-az;
      const nx=aby*acz-abz*acy, ny=abz*acx-abx*acz, nz=abx*acy-aby*acx;
      area += 0.5*Math.sqrt(nx*nx+ny*ny+nz*nz);
      signedVolume += (ax*(by*cz-bz*cy)-ay*(bx*cz-bz*cx)+az*(bx*cy-by*cx))/6;
    }
    return { surfaceArea: area, volume: Math.abs(signedVolume) };
  }

  private emitMetrics(): void {
    if (this.referencePositions) this.applyDifferenceHeatmap();
    this.metricsCallback?.(this.getMetrics());
  }


  public setPcaScores(
    rawScores: ArrayLike<number>,
    maximumComponents = 15,
    subjectId?: string,
    anatomicalLevel?: string,
  ): void {
    this.stopAnimation();

    if (this.numPcs === 0 || this.geometry === null) {
      throw new Error("No mesh generator is loaded.");
    }

    const componentCount = Math.min(
      maximumComponents,
      this.numPcs,
      rawScores.length,
    );

    this.zScores.fill(0);

    for (
      let componentIndex = 0;
      componentIndex < componentCount;
      componentIndex += 1
    ) {
      const standardDeviation = this.scoreStds[componentIndex];
      const rawScore = Number(rawScores[componentIndex]);

      const zScore =
        Number.isFinite(rawScore) && standardDeviation !== 0
          ? rawScore / standardDeviation
          : 0;

      this.zScores[componentIndex] = Math.max(
        this.sliderMinimum,
        Math.min(this.sliderMaximum, zScore),
      );
    }

    this.updateSliderControls(true);
    this.reconstruct();
    this.fitCamera();

    const templateLevel = this.currentLevel ?? "unknown template";
    const displayedLevel = anatomicalLevel ?? templateLevel;

    this.titleElement.textContent = subjectId
      ? `Generated vertebra — ${displayedLevel} · ${subjectId}`
      : `Generated vertebra — ${displayedLevel}`;

    this.setStatus(
      subjectId
        ? `Loaded ${componentCount} PCA scores for subject ${subjectId}, ` +
          `anatomical level ${displayedLevel}, reconstructed on the ` +
          `${templateLevel} template.`
        : `Loaded ${componentCount} PCA scores on the ${templateLevel} template.`,
    );
  }


  public downloadObj(filename = "generated-vertebra.obj"): void {
    if (this.geometry === null) {
      throw new Error("No generated mesh is available to download.");
    }

    const positionAttribute = this.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const positions = positionAttribute.array as ArrayLike<number>;
    const indexAttribute = this.geometry.getIndex();
    const lines: string[] = [
      "# Vertebra PCA Explorer OBJ export",
      `# ${this.currentLevel ?? "unknown level"}`,
    ];

    for (let index = 0; index < positions.length; index += 3) {
      lines.push(
        `v ${Number(positions[index]).toPrecision(9)} ` +
        `${Number(positions[index + 1]).toPrecision(9)} ` +
        `${Number(positions[index + 2]).toPrecision(9)}`,
      );
    }

    if (indexAttribute !== null) {
      const indices = indexAttribute.array as ArrayLike<number>;

      for (let index = 0; index < indices.length; index += 3) {
        lines.push(
          `f ${Number(indices[index]) + 1} ` +
          `${Number(indices[index + 1]) + 1} ` +
          `${Number(indices[index + 2]) + 1}`,
        );
      }
    } else {
      for (
        let vertexIndex = 0;
        vertexIndex + 2 < positionAttribute.count;
        vertexIndex += 3
      ) {
        lines.push(
          `f ${vertexIndex + 1} ${vertexIndex + 2} ${vertexIndex + 3}`,
        );
      }
    }

    const blob = new Blob(
      [`${lines.join("\n")}\n`],
      { type: "text/plain;charset=utf-8" },
    );
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename.toLowerCase().endsWith(".obj")
      ? filename
      : `${filename}.obj`;
    link.style.display = "none";

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 0);
  }


  private updateSliderControls(_expandBounds: boolean): void {
    const rows = this.slidersElement.querySelectorAll(
      ".pc-slider-row",
    );

    rows.forEach((row, componentIndex) => {
      const slider = row.querySelector(
        'input[type="range"]',
      ) as HTMLInputElement | null;
      const output = row.querySelector(
        "output",
      ) as HTMLOutputElement | null;
      const value = this.zScores[componentIndex] ?? 0;

      if (slider !== null) {
        slider.min = String(this.sliderMinimum);
        slider.max = String(this.sliderMaximum);
        slider.value = String(value);
      }

      if (output !== null) {
        const formatted = `${value.toFixed(2)} σ`;
        output.value = formatted;
        output.textContent = formatted;
      }
    });
  }


  public reset(): void {
    this.stopAnimation();

    if (this.numPcs === 0) {
      return;
    }

    this.zScores.fill(0);

    this.updateSliderControls(false);
    this.reconstruct();

    const levelLabel = this.currentLevel ?? "unknown level";
    this.titleElement.textContent = `Generated vertebra — ${levelLabel}`;
    this.setStatus("Components reset to the mean shape.");
  }


  public fitCamera(): void {
    if (this.geometry === null) {
      return;
    }

    this.geometry.computeBoundingSphere();

    const sphere = this.geometry.boundingSphere;

    if (sphere === null) {
      return;
    }

    const radius = Math.max(
      sphere.radius,
      0.001,
    );

    const verticalFov =
      THREE.MathUtils.degToRad(
        this.camera.fov,
      );

    const distance =
      radius / Math.sin(verticalFov / 2) * 1.15;

    this.camera.position.set(
      sphere.center.x,
      sphere.center.y,
      sphere.center.z + distance,
    );

    this.camera.near = Math.max(
      distance / 1_000,
      0.001,
    );

    this.camera.far = Math.max(
      distance * 100,
      1_000,
    );

    this.camera.updateProjectionMatrix();

    this.controls.target.copy(sphere.center);
    this.controls.update();
  }


  public setTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;

    const dark = theme === "dark";
    this.scene.background = new THREE.Color(dark ? 0x0e1622 : 0xf1f5fa);
    this.renderer.toneMappingExposure = dark ? 1.0 : 1.08;
    this.viewerElement.dataset.viewerTheme = theme;

    if (this.mesh !== null) {
      const materials = Array.isArray(this.mesh.material)
        ? this.mesh.material
        : [this.mesh.material];

      for (const material of materials) {
        this.applyMaterialTheme(material);
      }
    }
  }


  public refreshViewport(): void {
    this.resize();
  }


  private applyMaterialTheme(material: THREE.Material): void {
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      return;
    }

    const dark = this.currentTheme === "dark";

    material.color.setHex(dark ? 0xc8d8ec : 0xdbe6f4);
    material.emissive.setHex(dark ? 0x111b29 : 0x000000);
    material.emissiveIntensity = dark ? 0.08 : 0;
    material.needsUpdate = true;
  }


  public clear(message = "No generator available."): void {
    this.stopAnimation();
    this.loadGeneration += 1;
    this.numPcs = 0;
    this.numFeatures = 0;
    this.currentLevel = null;

    this.mean = new Float32Array();
    this.basis = new Float32Array();
    this.scoreStds = new Float32Array();
    this.zScores = new Float32Array();

    this.slidersElement.replaceChildren();
    this.disposeCurrentMesh();

    this.titleElement.textContent =
      "Generated vertebra";

    this.setStatus(message);
  }


  private disposeCurrentMesh(): void {
    if (this.mesh !== null) {
      this.scene.remove(this.mesh);

      const material = this.mesh.material;

      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
    }

    if (this.geometry !== null) {
      this.geometry.dispose();
    }

    this.mesh = null;
    this.geometry = null;
  }


  private setStatus(message: string): void {
    this.statusElement.textContent = message;
  }
}
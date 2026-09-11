import Plotly from "plotly.js-dist-min";
import Npyjs from "npyjs";
import Papa, { type ParseError, type ParseResult } from "papaparse";
import "./style.css";
import { VertebraViewer } from "./vertebra-viewer";

type DatasetDef = {
  key: string;
  npy: string;
  labels: string;
  generator?: string;
  analytics?: string;
  sampleMetrics?: string;
};

type MetaRow = {
  image_id: string;
  age: number | null;
  gender: string | null;
};

type LevelRow = {
  case_id: string;
  level: string | null;
};

type JoinedRow = {
  case_id: string;
  level: string | null;
  age: number | null;
  gender: string | null;
};

type Loaded = {
  X: number[][];
  levels: LevelRow[];
  metaById: Map<string, MetaRow>;
  joined: JoinedRow[];
};

type PcaAnalyticsData = {
  formatVersion: number;
  level: string;
  variant?: string;
  sampleCount: number | null;
  featureCount: number | null;
  componentCount: number;
  explainedVariance: number[];
  explainedVarianceRatio: number[];
  cumulativeExplainedVarianceRatio: number[];
  standardDeviations: number[];
  singularValues?: number[];
};


type PcaSampleMetric = {
  rowIndex: number;
  caseId: string;
  level: string;
  gender: string | null;
  age: number | null;
  mahalanobisAppropriate: number | null;
  mahalanobisReference: string | null;
  referenceSampleCount: number | null;
  surfaceAreaMm2: number | null;
  volumeCc: number | null;
};

type PcaReferencePoint = {
  level: string;
  gender: "All" | "Male" | "Female";
  sampleCount: number;
  pcScores: number[];
};

type PcaSampleMetricsData = {
  formatVersion: number;
  dataset: string;
  sampleCount: number;
  scoreComponentCount: number;
  mahalanobisComponentCount: number;
  samples: PcaSampleMetric[];
  references: PcaReferencePoint[];
};

type SubjectMeshEntry = {
  datasetKey: string;
  rowIndex: number;
  caseId: string;
  level: string;
  templateLevel: string;
};

type MetaCsvRow = {
  image_id?: unknown;
  case_id?: unknown;
  age?: unknown;
  gender?: unknown;
};

type LevelCsvRow = {
  case_id?: unknown;
  image_id?: unknown;
  level?: unknown;
};

type PlotDimension = 2 | 3;
type ThemePreference = "default" | "light" | "dark";
type ResolvedTheme = "light" | "dark";


type NumericArrayLike = {
  readonly length: number;
  readonly [index: number]: number | bigint;
};

type WorkspaceIds = {
  pcSelects: string;
  colorBy: string;
  filters: string;
  filterSummary: string;
  plot: string;
  plotButton: string;
  plotTitle: string;
  visibleCount: string;
  showReferences: string;
  sweep?: string;
  sweepButton?: string;
};

type PlotTheme = {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  primary: string;
  legendSurface: string;
};

const DATA_ROOT = `${import.meta.env.BASE_URL}data`;
const THEME_STORAGE_KEY = "vertebra-pca-theme";
const SYSTEM_DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");
const PLOTLY = Plotly as any;

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
  toImageButtonOptions: {
    format: "png",
    filename: "vertebra-pca-plot",
    scale: 2,
  },
};

const CATEGORICAL_COLORWAY = [
  "#4477aa",
  "#ee6677",
  "#228833",
  "#aa3377",
  "#66ccee",
  "#ccbb44",
  "#bbbbbb",
];

const GENDER_VISUALS: Record<string, { color: string; symbol: string }> = {
  Male: {
    color: "#0072b2",
    symbol: "circle",
  },
  Female: {
    color: "#d55e00",
    symbol: "diamond",
  },
  Unknown: {
    color: "#7f8c9f",
    symbol: "square",
  },
};

const REFERENCE_VISUALS: Record<"All" | "Male" | "Female", { color: string; symbol: string; label: string }> = {
  All: { color: "#7b2cbf", symbol: "cross", label: "Population means" },
  Male: { color: "#0072b2", symbol: "square", label: "Male means" },
  Female: { color: "#d55e00", symbol: "diamond", label: "Female means" },
};

const MAX_SWEEP_PLOTS = 9;
const APP_COMPONENT_LIMIT = 15;

const TEMPLATE_DISPLAY_LABELS: Record<string, string> = {
  C5: "C5 (C3-C7)",
  T6: "T6 (T1-T12)",
  L3: "L3 (L1-L5)",
};

function templateDisplayLabel(key: string): string {
  return TEMPLATE_DISPLAY_LABELS[key] ?? key;
}

function requiredElement<T extends HTMLElement>(
  id: string,
  constructor: { new (...args: any[]): T },
): T {
  const element = document.getElementById(id);

  if (!(element instanceof constructor)) {
    throw new Error(`Required element '#${id}' is missing or has the wrong type.`);
  }

  return element;
}

const elDataset = requiredElement("dataset", HTMLSelectElement);
const elDatasetStatus = requiredElement("dataset-status", HTMLSpanElement);
const elSampleCount = requiredElement("sample-count", HTMLElement);
const elComponentCount = requiredElement("component-count", HTMLElement);
const elCumulativeVariance = requiredElement("cumulative-variance", HTMLElement);
const elGeneratorState = requiredElement("generator-state", HTMLElement);
const elAppAlert = requiredElement("app-alert", HTMLDivElement);
const appLogo = requiredElement("app-logo", HTMLImageElement);
const themeChoiceButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"),
);

if (themeChoiceButtons.length === 0) {
  throw new Error("At least one theme choice button is required.");
}

const vertebraViewerElement = requiredElement("vertebra-viewer", HTMLElement);
const vertebraSlidersElement = requiredElement("vertebra-sliders", HTMLElement);
const vertebraStatusElement = requiredElement("vertebra-status", HTMLElement);
const vertebraTitleElement = requiredElement("vertebra-title", HTMLElement);
const vertebraResetButton = requiredElement("vertebra-reset", HTMLButtonElement);
const vertebraRecenterButton = requiredElement("vertebra-recenter", HTMLButtonElement);
const vertebraDownloadButton = requiredElement("vertebra-download", HTMLButtonElement);
const vertebraSubjectSelect = requiredElement("vertebra-subject", HTMLSelectElement);
const vertebraLevelSelect = requiredElement("vertebra-level", HTMLSelectElement);
const vertebraResetSubjectButton = requiredElement(
  "vertebra-reset-subject",
  HTMLButtonElement,
);
const variancePlotElement = requiredElement("variance-plot", HTMLDivElement);
const eigenvalueTableBody = requiredElement("eigenvalue-table-body", HTMLTableSectionElement);
const mahalanobisSummary = requiredElement("mahalanobis-summary", HTMLDivElement);
const surfaceAreaElement = requiredElement("surface-area", HTMLElement);
const meshVolumeElement = requiredElement("mesh-volume", HTMLElement);
const randomButton = requiredElement("vertebra-random", HTMLButtonElement);
const animatePcSelect = requiredElement("animate-pc", HTMLSelectElement);
const animatePcButton = requiredElement("animate-pc-button", HTMLButtonElement);
const differenceReferenceSelect = requiredElement("difference-reference", HTMLSelectElement);
const pcValuesDownloadButton = requiredElement("pc-values-download", HTMLButtonElement);
const pcValuesLoadInput = requiredElement("pc-values-load", HTMLInputElement);

const vertebraViewer = new VertebraViewer(
  vertebraViewerElement,
  vertebraSlidersElement,
  vertebraStatusElement,
  vertebraTitleElement,
  (metrics) => {
    surfaceAreaElement.textContent = metrics.surfaceArea.toFixed(2);
    meshVolumeElement.textContent = (metrics.volume / 1000).toFixed(2);
    updateMahalanobisSummary();
  },
  (isAnimating) => {
    animatePcButton.textContent = isAnimating ? "Stop animation" : "Animate";
    animatePcButton.classList.toggle("btn-danger", isAnimating);
    animatePcButton.classList.toggle("btn-outline-secondary", !isAnimating);
  },
);

vertebraViewer.setTheme(
  document.documentElement.getAttribute("data-bs-theme") === "dark"
    ? "dark"
    : "light",
);

vertebraResetButton.addEventListener("click", () => {
  resetSubjectSelection(false);
  vertebraViewer.reset();
});

vertebraRecenterButton.addEventListener("click", () => {
  vertebraViewer.stopAnimation();
  vertebraViewer.fitCamera();
});

vertebraDownloadButton.addEventListener("click", () => {
  vertebraViewer.stopAnimation();

  try {
    const subject = vertebraSubjectSelect.value || "generated";
    const level = vertebraLevelSelect.value || elDataset.value || "vertebra";
    vertebraViewer.downloadObj(
      `${sanitiseFilenamePart(subject)}-${sanitiseFilenamePart(level)}.obj`,
    );
  } catch (error) {
    showError(error);
  }
});

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  elAppAlert.textContent = message;
  elAppAlert.classList.remove("d-none");
}

function clearError(): void {
  elAppAlert.replaceChildren();
  elAppAlert.classList.add("d-none");
}

function setDatasetStatus(
  state: "loading" | "ready" | "error",
  label: string,
): void {
  elDatasetStatus.textContent = label;
  elDatasetStatus.classList.toggle("is-ready", state === "ready");
  elDatasetStatus.classList.toggle("is-error", state === "error");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.arrayBuffer();
}

async function loadCsvRows<T extends Record<string, unknown>>(
  url: string,
): Promise<T[]> {
  const csv = await fetchText(url);

  return new Promise<T[]>((resolve, reject) => {
    Papa.parse<T>(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header: string) => header.trim().toLowerCase(),
      complete: (result: ParseResult<T>) => {
        if (result.errors.length > 0) {
          const details = result.errors
            .map((error: ParseError) => {
              const row = error.row !== undefined ? `row ${error.row}` : "unknown row";
              return `${row}: ${error.message}`;
            })
            .join("; ");

          reject(new Error(`Could not parse CSV ${url}: ${details}`));
          return;
        }

        resolve(result.data);
      },
      error: (error: Error) => {
        reject(new Error(`Could not read CSV ${url}: ${error.message}`));
      },
    });
  });
}

async function loadMeta(metaUrl: string): Promise<Map<string, MetaRow>> {
  const rows = await loadCsvRows<MetaCsvRow>(metaUrl);
  const result = new Map<string, MetaRow>();

  for (const [index, row] of rows.entries()) {
    const rawId = row.image_id ?? row.case_id;
    const imageId = rawId === null || rawId === undefined
      ? ""
      : String(rawId).trim();

    if (!imageId) {
      console.warn(`Skipping metadata row ${index + 2}: missing image_id`);
      continue;
    }

    const rawAge = row.age;
    const parsedAge = rawAge === null || rawAge === undefined || String(rawAge).trim() === ""
      ? null
      : Number(rawAge);
    const age = parsedAge !== null && Number.isFinite(parsedAge)
      ? parsedAge
      : null;

    const genderText = row.gender === null || row.gender === undefined
      ? ""
      : String(row.gender).trim().toLowerCase();

    let gender: string | null;

    switch (genderText) {
      case "m":
      case "male":
        gender = "Male";
        break;
      case "f":
      case "female":
        gender = "Female";
        break;
      case "":
        gender = null;
        break;
      default:
        gender = "Unknown";
        break;
    }

    if (result.has(imageId)) {
      console.warn(
        `Duplicate metadata entry for image_id '${imageId}'. ` +
        "The later row will replace the earlier row.",
      );
    }

    result.set(imageId, {
      image_id: imageId,
      age,
      gender,
    });
  }

  return result;
}

async function loadLevelsCsv(csvUrl: string): Promise<LevelRow[]> {
  const rows = await loadCsvRows<LevelCsvRow>(csvUrl);

  const result = rows.map((row, index): LevelRow => {
    const rawCaseId = row.case_id ?? row.image_id;
    const rawLevel = row.level;
    const caseId = rawCaseId === null || rawCaseId === undefined
      ? ""
      : String(rawCaseId).trim();
    const level = rawLevel === null || rawLevel === undefined
      ? null
      : String(rawLevel).trim() || null;

    if (!caseId) {
      throw new Error(`Missing case_id in ${csvUrl} at data row ${index + 2}`);
    }

    return {
      case_id: caseId,
      level,
    };
  });

  if (result.length === 0) {
    throw new Error(`No label rows found in ${csvUrl}`);
  }

  return result;
}

function asNumericArrayLike(
  data: ArrayBufferView<ArrayBufferLike>,
): NumericArrayLike {
  if (data instanceof DataView) {
    throw new Error("NPY payload unexpectedly contains a DataView.");
  }

  return data as unknown as NumericArrayLike;
}

async function loadNpy(npyUrl: string): Promise<number[][]> {
  const npy = new Npyjs();
  const buffer = await fetchArrayBuffer(npyUrl);
  const array = await npy.parse(buffer);
  const shape = Array.from(array.shape, Number);

  if (shape.length !== 2) {
    throw new Error(`Expected a 2D NPY array. Got shape=${shape.join("x")}`);
  }

  const [sampleCount, componentCount] = shape;
  const data = asNumericArrayLike(array.data);
  const result: number[][] = new Array(sampleCount);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const row: number[] = new Array(componentCount);

    for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
      row[componentIndex] = Number(data[sampleIndex * componentCount + componentIndex]);
    }

    result[sampleIndex] = row;
  }

  return result;
}

async function loadAll(definition: DatasetDef): Promise<Loaded> {
  const [X, levels, metaById] = await Promise.all([
    loadNpy(`${DATA_ROOT}/${definition.npy}`),
    loadLevelsCsv(`${DATA_ROOT}/${definition.labels}`),
    loadMeta(`${DATA_ROOT}/meta.csv`),
  ]);

  if (levels.length !== X.length) {
    throw new Error(
      [
        `Row-count mismatch for dataset ${definition.key}.`,
        `PCA array: ${X.length} samples.`,
        `Labels file: ${levels.length} rows.`,
        "The label rows must have the same ordering as the PCA samples.",
      ].join(" "),
    );
  }

  const joined = levels.map((row, index): JoinedRow => {
    const metadata = metaById.get(row.case_id);

    if (!metadata) {
      console.warn(`No metadata found for case_id '${row.case_id}' at PCA row ${index}`);
    }

    return {
      case_id: row.case_id,
      level: row.level,
      age: metadata?.age ?? null,
      gender: metadata?.gender ?? null,
    };
  });

  return {
    X,
    levels,
    metaById,
    joined,
  };
}

function getPlotTheme(): PlotTheme {
  const styles = getComputedStyle(document.documentElement);

  return {
    ink: styles.getPropertyValue("--ink").trim() || "#172033",
    muted: styles.getPropertyValue("--ink-muted").trim() || "#64748b",
    line: styles.getPropertyValue("--line").trim() || "#dce4ef",
    surface: styles.getPropertyValue("--surface").trim() || "#ffffff",
    primary: styles.getPropertyValue("--primary").trim() || "#2867d8",
    legendSurface:
      styles.getPropertyValue("--plot-legend-bg").trim() ||
      "rgba(255, 255, 255, 0.86)",
  };
}

class PlotWorkspace {
  private readonly dimension: PlotDimension;
  private readonly pcSelectsElement: HTMLDivElement;
  private readonly colorByElement: HTMLSelectElement;
  private readonly filtersElement: HTMLDivElement;
  private readonly filterSummaryElement: HTMLElement;
  private readonly plotElement: HTMLDivElement;
  private readonly plotButton: HTMLButtonElement;
  private readonly plotTitleElement: HTMLElement;
  private readonly visibleCountElement: HTMLElement;
  private readonly showReferencesElement: HTMLInputElement;
  private readonly sweepElement: HTMLDivElement | null;
  private readonly sweepButton: HTMLButtonElement | null;

  private loaded: Loaded | null = null;
  private sampleMetrics: PcaSampleMetricsData | null = null;
  private genderFilter: Set<string> | null = null;
  private levelFilter: Set<string> | null = null;
  private ageMinMax: [number, number] | null = null;
  private showingSweep = false;

  public constructor(dimension: PlotDimension, ids: WorkspaceIds) {
    this.dimension = dimension;
    this.pcSelectsElement = requiredElement(ids.pcSelects, HTMLDivElement);
    this.colorByElement = requiredElement(ids.colorBy, HTMLSelectElement);
    this.filtersElement = requiredElement(ids.filters, HTMLDivElement);
    this.filterSummaryElement = requiredElement(ids.filterSummary, HTMLElement);
    this.plotElement = requiredElement(ids.plot, HTMLDivElement);
    this.plotButton = requiredElement(ids.plotButton, HTMLButtonElement);
    this.plotTitleElement = requiredElement(ids.plotTitle, HTMLElement);
    this.visibleCountElement = requiredElement(ids.visibleCount, HTMLElement);
    this.showReferencesElement = requiredElement(ids.showReferences, HTMLInputElement);
    this.sweepElement = ids.sweep
      ? requiredElement(ids.sweep, HTMLDivElement)
      : null;
    this.sweepButton = ids.sweepButton
      ? requiredElement(ids.sweepButton, HTMLButtonElement)
      : null;

    this.plotButton.addEventListener("click", () => {
      this.requestPlot();
    });

    this.sweepButton?.addEventListener("click", () => {
      this.requestSweep();
    });

    this.colorByElement.addEventListener("change", () => {
      this.rebuildFilters();
      this.requestCurrentView();
    });

    this.showReferencesElement.addEventListener("change", () => {
      this.requestCurrentView();
    });
  }

  public setLoaded(
    loaded: Loaded,
    sampleMetrics: PcaSampleMetricsData | null,
  ): void {
    this.loaded = loaded;
    this.sampleMetrics = sampleMetrics;
    this.updateMetricColourOptions();
    this.showingSweep = false;
    this.buildPCSelectors(loaded.X[0].length);
    this.rebuildFilters();
    this.showMainPlot();
  }

  public async plot(): Promise<void> {
    if (!this.loaded) {
      return;
    }

    this.showMainPlot();

    const selectedPcs = this.getSelectedPCs();
    const indices = this.applyMask();
    const traces = this.buildTraces(indices, selectedPcs, this.dimension);
    const theme = getPlotTheme();

    this.updateVisibleSummary(indices.length);

    if (this.dimension === 2) {
      this.plotTitleElement.textContent =
        `PC${selectedPcs[0]} versus PC${selectedPcs[1]}`;

      await PLOTLY.react(
        this.plotElement,
        traces,
        {
          autosize: true,
          paper_bgcolor: "rgba(0, 0, 0, 0)",
          plot_bgcolor: theme.surface,
          font: {
            family: "Inter, system-ui, sans-serif",
            color: theme.ink,
            size: 12,
          },
          colorway: CATEGORICAL_COLORWAY,
          margin: { l: 66, r: 28, t: 26, b: 62 },
          hovermode: "closest",
          legend: {
            orientation: "h",
            x: 0,
            y: 1.08,
            xanchor: "left",
            yanchor: "bottom",
            bgcolor: theme.legendSurface,
            bordercolor: theme.line,
            borderwidth: 1,
          },
          xaxis: this.axisLayout(`PC${selectedPcs[0]}`, theme),
          yaxis: this.axisLayout(`PC${selectedPcs[1]}`, theme),
        },
        PLOT_CONFIG,
      );

      this.bindSampleClick(this.plotElement);
    } else {
      this.plotTitleElement.textContent =
        `PC${selectedPcs[0]}, PC${selectedPcs[1]} and PC${selectedPcs[2]}`;

      await PLOTLY.react(
        this.plotElement,
        traces,
        {
          autosize: true,
          paper_bgcolor: "rgba(0, 0, 0, 0)",
          font: {
            family: "Inter, system-ui, sans-serif",
            color: theme.ink,
            size: 12,
          },
          colorway: CATEGORICAL_COLORWAY,
          margin: { l: 0, r: 0, t: 10, b: 0 },
          legend: {
            x: 0.02,
            y: 0.98,
            bgcolor: theme.legendSurface,
            bordercolor: theme.line,
            borderwidth: 1,
          },
          scene: {
            bgcolor: theme.surface,
            xaxis: this.sceneAxisLayout(`PC${selectedPcs[0]}`, theme),
            yaxis: this.sceneAxisLayout(`PC${selectedPcs[1]}`, theme),
            zaxis: this.sceneAxisLayout(`PC${selectedPcs[2]}`, theme),
            camera: {
              eye: { x: 1.5, y: 1.5, z: 1.25 },
            },
          },
        },
        PLOT_CONFIG,
      );

      this.bindSampleClick(this.plotElement);
    }
  }

  public async plotSweep(): Promise<void> {
    if (!this.loaded || !this.sweepElement) {
      return;
    }

    const componentCount = this.loaded.X[0].length;
    const pairCount = Math.min(
      MAX_SWEEP_PLOTS,
      Math.max(0, componentCount - 1),
    );
    const pairs: [number, number][] = Array.from(
      { length: pairCount },
      (_, componentIndex): [number, number] => [
        componentIndex,
        componentIndex + 1,
      ],
    );

    if (pairs.length === 0) {
      showError("At least two PCA components are required for a sweep plot.");
      return;
    }

    clearError();
    this.clearSweepPlots();
    this.showingSweep = true;
    PLOTLY.purge(this.plotElement);
    this.plotElement.classList.add("d-none");
    this.sweepElement.classList.remove("d-none");

    const indices = this.applyMask();
    const theme = getPlotTheme();

    this.plotTitleElement.textContent = `${pairs.length}-plot adjacent principal-component sweep`;
    this.updateVisibleSummary(indices.length);

    for (const pair of pairs) {
      const plot = document.createElement("div");
      plot.className = "sweep-plot";
      plot.setAttribute("aria-label", `PC${pair[0]} versus PC${pair[1]}`);
      this.sweepElement.appendChild(plot);

      // Sweep plots deliberately use Plotly's SVG renderer instead of
      // scattergl. Nine separate WebGL figures can exceed the browser's
      // active-context limit when combined with the 3D PCA and Three.js views.
      const traces = this.buildTraces(indices, pair, 2, 5, false);

      await PLOTLY.newPlot(
        plot,
        traces,
        {
          autosize: true,
          paper_bgcolor: "rgba(0, 0, 0, 0)",
          plot_bgcolor: theme.surface,
          font: {
            family: "Inter, system-ui, sans-serif",
            color: theme.ink,
            size: 11,
          },
          colorway: CATEGORICAL_COLORWAY,
          title: {
            text: `PC${pair[0]} vs PC${pair[1]}`,
            x: 0.06,
            xanchor: "left",
            font: { size: 14 },
          },
          showlegend: false,
          margin: { l: 52, r: 18, t: 48, b: 48 },
          xaxis: this.axisLayout(`PC${pair[0]}`, theme),
          yaxis: this.axisLayout(`PC${pair[1]}`, theme),
        },
        {
          ...PLOT_CONFIG,
          displayModeBar: false,
          scrollZoom: false,
        },
      );

      this.bindSampleClick(plot);
    }
  }

  public async refreshCurrentView(): Promise<void> {
    if (this.showingSweep && this.sweepElement) {
      await this.plotSweep();
      return;
    }

    await this.plot();
  }

  public resize(): void {
    if (this.showingSweep && this.sweepElement) {
      this.sweepElement.querySelectorAll<HTMLElement>(".sweep-plot").forEach((plot) => {
        PLOTLY.Plots.resize(plot);
      });
      return;
    }

    PLOTLY.Plots.resize(this.plotElement);
  }

  private bindSampleClick(plotElement: HTMLElement): void {
    const plot = plotElement as any;

    if (typeof plot.removeAllListeners === "function") {
      plot.removeAllListeners("plotly_click");
    }

    if (typeof plot.on !== "function") {
      return;
    }

    plot.on("plotly_click", (event: any) => {
      const point = event?.points?.[0];
      const customData = point?.customdata;
      if (
        Array.isArray(customData) &&
        (customData[9] === "reference" || customData[5] === "reference")
      ) {
        return;
      }

      const rowIndex = Number(
        Array.isArray(customData)
          ? customData[4]
          : customData?.rowIndex ?? point?.pointIndex,
      );

      if (!Number.isInteger(rowIndex) || rowIndex < 0) {
        return;
      }

      void selectSampleFromPlot(rowIndex).catch((error) => {
        console.error(error);
        showError(error);
      });
    });
  }

  private requestCurrentView(): void {
    void this.refreshCurrentView().catch((error) => {
      console.error(error);
      showError(error);
    });
  }

  private requestPlot(): void {
    void this.plot().catch((error) => {
      console.error(error);
      showError(error);
    });
  }

  private requestSweep(): void {
    void this.plotSweep().catch((error) => {
      console.error(error);
      showError(error);
    });
  }

  private buildPCSelectors(componentCount: number): void {
    this.pcSelectsElement.replaceChildren();
    const axisNames = this.dimension === 2 ? ["X axis", "Y axis"] : ["X axis", "Y axis", "Z axis"];
    const axisLetters = ["X", "Y", "Z"];

    for (let axisIndex = 0; axisIndex < this.dimension; axisIndex += 1) {
      const wrapper = document.createElement("div");
      wrapper.className = "pc-field";

      const label = document.createElement("label");
      label.className = "form-label";

      const labelText = document.createElement("span");
      labelText.textContent = axisNames[axisIndex];

      const chip = document.createElement("span");
      chip.className = "axis-chip";
      chip.textContent = axisLetters[axisIndex];
      chip.setAttribute("aria-hidden", "true");

      const select = document.createElement("select");
      select.className = "form-select";
      select.id = `pc-${this.dimension}d-axis-${axisIndex}`;
      label.htmlFor = select.id;
      label.append(labelText, chip);

      for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
        const option = document.createElement("option");
        option.value = String(componentIndex);
        option.textContent = `PC${componentIndex}`;
        option.selected = componentIndex === Math.min(axisIndex, componentCount - 1);
        select.appendChild(option);
      }

      select.addEventListener("change", () => {
        this.requestPlot();
      });

      wrapper.append(label, select);
      this.pcSelectsElement.appendChild(wrapper);
    }
  }

  private getSelectedPCs(): number[] {
    return Array.from(this.pcSelectsElement.querySelectorAll("select")).map(
      (select) => Number((select as HTMLSelectElement).value),
    );
  }

  private rebuildFilters(): void {
    this.filtersElement.replaceChildren();
    this.genderFilter = null;
    this.levelFilter = null;
    this.ageMinMax = null;

    if (!this.loaded) {
      return;
    }

    const colorBy = this.colorByElement.value;

    if (colorBy === "none") {
      const message = document.createElement("p");
      message.className = "filter-empty";
      message.textContent = "Choose a metadata field above to expose its matching filters.";
      this.filtersElement.appendChild(message);
      this.updateVisibleSummary(this.loaded.joined.length);
      return;
    }

    if (colorBy === "gender") {
      const genders = Array.from(
        new Set(this.loaded.joined.map((row) => row.gender ?? "Unknown")),
      ).sort();

      const selected = new Set(genders);
      this.genderFilter = selected;
      this.appendCheckboxFilters(genders, selected, GENDER_VISUALS);
      return;
    }

    if (colorBy === "level") {
      const levels = Array.from(
        new Set(this.loaded.joined.map((row) => row.level ?? "Unknown")),
      ).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

      const selected = new Set(levels);
      this.levelFilter = selected;
      this.appendCheckboxFilters(levels, selected);
      return;
    }

    if (colorBy === "age") {
      const ages = this.loaded.joined
        .map((row) => row.age)
        .filter((age): age is number => age !== null);

      if (ages.length === 0) {
        const message = document.createElement("p");
        message.className = "filter-empty";
        message.textContent = "No age metadata is available for this dataset.";
        this.filtersElement.appendChild(message);
        return;
      }

      const minimum = Math.floor(Math.min(...ages));
      const maximum = Math.ceil(Math.max(...ages));
      this.ageMinMax = [minimum, maximum];

      const controls = document.createElement("div");
      controls.className = "age-range-controls";
      const lower = this.createAgeSlider("Lower age", minimum, minimum, maximum);
      const upper = this.createAgeSlider("Upper age", maximum, minimum, maximum);
      controls.append(lower.wrapper, upper.wrapper);
      this.filtersElement.appendChild(controls);

      const updateAgeFilter = (changed: "lower" | "upper"): void => {
        let lowerValue = Number(lower.input.value);
        let upperValue = Number(upper.input.value);

        if (changed === "lower" && lowerValue > upperValue) {
          upperValue = lowerValue;
          upper.input.value = String(upperValue);
        } else if (changed === "upper" && upperValue < lowerValue) {
          lowerValue = upperValue;
          lower.input.value = String(lowerValue);
        }

        lower.output.value = String(lowerValue);
        lower.output.textContent = String(lowerValue);
        upper.output.value = String(upperValue);
        upper.output.textContent = String(upperValue);
        this.ageMinMax = [lowerValue, upperValue];
        this.requestCurrentView();
      };

      lower.input.addEventListener("input", () => updateAgeFilter("lower"));
      upper.input.addEventListener("input", () => updateAgeFilter("upper"));
      return;
    }

    const message = document.createElement("p");
    message.className = "filter-empty";
    message.textContent =
      "This continuous mesh metric is used for colouring; all samples remain visible.";
    this.filtersElement.appendChild(message);
    this.updateVisibleSummary(this.loaded.joined.length);
  }

  private appendCheckboxFilters(
    values: string[],
    selected: Set<string>,
    visuals?: Record<string, { color: string; symbol: string }>,
  ): void {
    for (const [index, value] of values.entries()) {
      const wrapper = document.createElement("label");
      wrapper.className = "filter-check";

      const checkbox = document.createElement("input");
      checkbox.className = "form-check-input";
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.id = `filter-${this.dimension}d-${index}`;

      const text = document.createElement("span");
      text.textContent = value;

      const visual = visuals?.[value];
      const swatch = visual ? document.createElement("span") : null;

      if (swatch && visual) {
        swatch.className = `filter-swatch filter-swatch-${visual.symbol}`;
        swatch.style.setProperty("--filter-swatch-color", visual.color);
        swatch.setAttribute("aria-hidden", "true");
      }

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selected.add(value);
        } else {
          selected.delete(value);
        }

        this.requestCurrentView();
      });

      wrapper.htmlFor = checkbox.id;
      wrapper.append(checkbox);

      if (swatch) {
        wrapper.appendChild(swatch);
      }

      wrapper.appendChild(text);
      this.filtersElement.appendChild(wrapper);
    }
  }

  private createAgeSlider(
    labelText: string,
    value: number,
    minimum: number,
    maximum: number,
  ): {
    wrapper: HTMLDivElement;
    input: HTMLInputElement;
    output: HTMLOutputElement;
  } {
    const wrapper = document.createElement("div");
    wrapper.className = "age-range-control";

    const heading = document.createElement("div");
    heading.className = "age-range-heading";

    const label = document.createElement("label");
    label.className = "form-label mb-0";
    label.textContent = labelText;

    const output = document.createElement("output");
    output.className = "age-range-value";
    output.value = String(value);
    output.textContent = String(value);

    const input = document.createElement("input");
    input.className = "form-range";
    input.type = "range";
    input.min = String(minimum);
    input.max = String(maximum);
    input.step = "1";
    input.value = String(value);
    input.id = `age-${this.dimension}d-${labelText.toLowerCase().replace(/\s+/g, "-")}`;
    label.htmlFor = input.id;

    heading.append(label, output);
    wrapper.append(heading, input);
    return { wrapper, input, output };
  }

  private applyMask(): number[] {
    if (!this.loaded) {
      return [];
    }

    const indices: number[] = [];

    for (let index = 0; index < this.loaded.joined.length; index += 1) {
      const row = this.loaded.joined[index];

      if (this.genderFilter && !this.genderFilter.has(row.gender ?? "Unknown")) {
        continue;
      }

      if (this.levelFilter && !this.levelFilter.has(row.level ?? "Unknown")) {
        continue;
      }

      if (this.ageMinMax) {
        if (row.age === null || row.age < this.ageMinMax[0] || row.age > this.ageMinMax[1]) {
          continue;
        }
      }

      indices.push(index);
    }

    return indices;
  }

  private buildTraces(
    indices: number[],
    selectedPcs: number[],
    dimension: PlotDimension,
    markerSize?: number,
    useWebGl = true,
  ): any[] {
    if (!this.loaded) {
      return [];
    }

    const colorBy = this.colorByElement.value;
    let traces: any[];

    if (colorBy === "gender" || colorBy === "level") {
      const grouped = new Map<string, number[]>();

      for (const index of indices) {
        const row = this.loaded.joined[index];
        const category = colorBy === "gender"
          ? row.gender ?? "Unknown"
          : row.level ?? "Unknown";
        const group = grouped.get(category) ?? [];
        group.push(index);
        grouped.set(category, group);
      }

      traces = Array.from(grouped.entries())
        .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
        .map(([category, groupIndices]) =>
          this.createTrace(
            groupIndices,
            selectedPcs,
            dimension,
            category,
            markerSize,
            useWebGl,
          ),
        );
    } else {
      traces = [
        this.createTrace(
          indices,
          selectedPcs,
          dimension,
          undefined,
          markerSize,
          useWebGl,
        ),
      ];
    }

    if (this.showReferencesElement.checked) {
      traces.push(...this.createReferenceTraces(selectedPcs, dimension, useWebGl));
    }

    return traces;
  }

  private createTrace(
    indices: number[],
    selectedPcs: number[],
    dimension: PlotDimension,
    name?: string,
    markerSize?: number,
    useWebGl = true,
  ): any {
    if (!this.loaded) {
      return {};
    }

    const colorBy = this.colorByElement.value;
    const customData = indices.map((index) => {
      const row = this.loaded!.joined[index];
      const metric = this.sampleMetrics?.samples[index] ?? null;

      return [
        row.case_id,
        row.level ?? "Unknown",
        row.gender ?? "Unknown",
        row.age ?? "Unknown",
        index,
        this.formatOptionalMetric(metric?.mahalanobisAppropriate, 2),
        metric?.mahalanobisReference ?? "Unavailable",
        this.formatOptionalMetric(metric?.surfaceAreaMm2, 2),
        this.formatOptionalMetric(metric?.volumeCc, 2),
        "sample",
      ];
    });

    const marker: Record<string, unknown> = {
      size: markerSize ?? (dimension === 2 ? 7 : 4),
      opacity: 0.84,
      line: dimension === 2
        ? { color: "rgba(255,255,255,0.9)", width: 0.8 }
        : undefined,
    };

    if (colorBy === "gender" && name !== undefined) {
      const visual = GENDER_VISUALS[name] ?? GENDER_VISUALS.Unknown;
      marker.color = visual.color;
      marker.symbol = visual.symbol;
    }

    const continuous = this.continuousColourDefinition(colorBy);
    if (continuous !== null) {
      marker.color = indices.map((index) => continuous.value(index));
      marker.colorscale = continuous.colorscale;
      marker.showscale = true;
      marker.colorbar = {
        title: { text: continuous.title },
        thickness: 13,
        outlinewidth: 0,
      };
    }

    if (colorBy === "none") {
      marker.color = getPlotTheme().primary;
    }

    const trace: any = {
      type: dimension === 2
        ? (useWebGl ? "scattergl" : "scatter")
        : "scatter3d",
      mode: "markers",
      name,
      showlegend: name !== undefined,
      x: indices.map((index) => this.loaded!.X[index][selectedPcs[0]]),
      y: indices.map((index) => this.loaded!.X[index][selectedPcs[1]]),
      marker,
      customdata: customData,
      hovertemplate:
        "<b>%{customdata[0]}</b><br>" +
        "Level: %{customdata[1]}<br>" +
        "Gender: %{customdata[2]}<br>" +
        "Age: %{customdata[3]}<br>" +
        "Mahalanobis: %{customdata[5]}<br>" +
        "Reference: %{customdata[6]}<br>" +
        "Surface area: %{customdata[7]} mm²<br>" +
        "Volume: %{customdata[8]} CC<br>" +
        `PC${selectedPcs[0]}: %{x:.3f}<br>` +
        `PC${selectedPcs[1]}: %{y:.3f}` +
        (dimension === 3 ? `<br>PC${selectedPcs[2]}: %{z:.3f}` : "") +
        "<extra></extra>",
    };

    if (dimension === 3) {
      trace.z = indices.map((index) => this.loaded!.X[index][selectedPcs[2]]);
    }

    return trace;
  }

  private continuousColourDefinition(
    colorBy: string,
  ): {
    title: string;
    colorscale: string;
    value: (index: number) => number | null;
  } | null {
    if (colorBy === "age") {
      return {
        title: "Age",
        colorscale: "Viridis",
        value: (index) => this.loaded?.joined[index].age ?? null,
      };
    }

    if (colorBy === "mahalanobis") {
      return {
        title: "Mahalanobis",
        colorscale: "Plasma",
        value: (index) => this.sampleMetrics?.samples[index]?.mahalanobisAppropriate ?? null,
      };
    }

    if (colorBy === "surfaceArea") {
      return {
        title: "Area (mm²)",
        colorscale: "Viridis",
        value: (index) => this.sampleMetrics?.samples[index]?.surfaceAreaMm2 ?? null,
      };
    }

    if (colorBy === "volume") {
      return {
        title: "Volume (CC)",
        colorscale: "Cividis",
        value: (index) => this.sampleMetrics?.samples[index]?.volumeCc ?? null,
      };
    }

    return null;
  }

  private formatOptionalMetric(
    value: number | null | undefined,
    digits: number,
  ): string {
    return value !== null && value !== undefined && Number.isFinite(value)
      ? value.toFixed(digits)
      : "Unavailable";
  }

  private createReferenceTraces(
    selectedPcs: number[],
    dimension: PlotDimension,
    useWebGl: boolean,
  ): any[] {
    const references = this.referencePoints().filter((reference) => {
      if (reference.pcScores.length <= Math.max(...selectedPcs)) {
        return false;
      }
      if (this.levelFilter && !this.levelFilter.has(reference.level)) {
        return false;
      }
      if (
        this.genderFilter &&
        reference.gender !== "All" &&
        !this.genderFilter.has(reference.gender)
      ) {
        return false;
      }
      return true;
    });

    return (["All", "Female", "Male"] as const)
      .map((gender) => {
        const group = references.filter((reference) => reference.gender === gender);
        if (group.length === 0) {
          return null;
        }

        const visual = REFERENCE_VISUALS[gender];
        const trace: any = {
          type: dimension === 2
            ? (useWebGl ? "scattergl" : "scatter")
            : "scatter3d",
          mode: "markers+text",
          name: visual.label,
          showlegend: true,
          x: group.map((reference) => reference.pcScores[selectedPcs[0]]),
          y: group.map((reference) => reference.pcScores[selectedPcs[1]]),
          text: group.map((reference) => reference.level),
          textposition: dimension === 2 ? "top center" : undefined,
          marker: {
            color: visual.color,
            symbol: visual.symbol,
            size: dimension === 2 ? 12 : 7,
            opacity: 1,
            line: { color: "rgba(255,255,255,0.95)", width: 1.5 },
          },
          customdata: group.map((reference) => [
            visual.label,
            reference.level,
            gender,
            reference.sampleCount,
            -1,
            "reference",
          ]),
          hovertemplate:
            "<b>%{customdata[0]}</b><br>" +
            "Level: %{customdata[1]}<br>" +
            "Group: %{customdata[2]}<br>" +
            "Samples: %{customdata[3]}<br>" +
            `PC${selectedPcs[0]}: %{x:.3f}<br>` +
            `PC${selectedPcs[1]}: %{y:.3f}` +
            (dimension === 3 ? `<br>PC${selectedPcs[2]}: %{z:.3f}` : "") +
            "<extra></extra>",
        };

        if (dimension === 3) {
          trace.z = group.map((reference) => reference.pcScores[selectedPcs[2]]);
          delete trace.textposition;
        }

        return trace;
      })
      .filter((trace): trace is any => trace !== null);
  }

  private referencePoints(): PcaReferencePoint[] {
    if (this.sampleMetrics?.references.length) {
      return this.sampleMetrics.references;
    }

    if (!this.loaded) {
      return [];
    }

    const groups = new Map<string, { level: string; gender: "All" | "Male" | "Female"; indices: number[] }>();
    for (const [index, row] of this.loaded.joined.entries()) {
      const level = row.level ?? "Unknown";
      const allKey = `${level}\u0000All`;
      const allGroup = groups.get(allKey) ?? { level, gender: "All", indices: [] };
      allGroup.indices.push(index);
      groups.set(allKey, allGroup);

      if (row.gender === "Male" || row.gender === "Female") {
        const key = `${level}\u0000${row.gender}`;
        const group = groups.get(key) ?? { level, gender: row.gender, indices: [] };
        group.indices.push(index);
        groups.set(key, group);
      }
    }

    return Array.from(groups.values()).map((group) => ({
      level: group.level,
      gender: group.gender,
      sampleCount: group.indices.length,
      pcScores: this.loaded!.X[0].map((_, componentIndex) =>
        group.indices.reduce(
          (sum, sampleIndex) => sum + this.loaded!.X[sampleIndex][componentIndex],
          0,
        ) / group.indices.length,
      ),
    }));
  }

  private updateMetricColourOptions(): void {
    const available = this.sampleMetrics !== null;
    for (const option of Array.from(this.colorByElement.options)) {
      if (["mahalanobis", "surfaceArea", "volume"].includes(option.value)) {
        option.disabled = !available;
        option.title = available
          ? ""
          : "Run export_pca_sample_metrics_for_web.py for this template first.";
      }
    }

    if (!available && ["mahalanobis", "surfaceArea", "volume"].includes(this.colorByElement.value)) {
      this.colorByElement.value = "none";
    }
  }

  private axisLayout(title: string, theme: PlotTheme): Record<string, unknown> {
    return {
      title: {
        text: title,
        standoff: 12,
        font: { size: 12, color: theme.muted },
      },
      gridcolor: theme.line,
      zerolinecolor: theme.line,
      linecolor: theme.line,
      tickfont: { color: theme.muted },
      automargin: true,
    };
  }

  private sceneAxisLayout(title: string, theme: PlotTheme): Record<string, unknown> {
    return {
      title: { text: title, font: { size: 12, color: theme.muted } },
      backgroundcolor: theme.surface,
      gridcolor: theme.line,
      zerolinecolor: theme.line,
      showbackground: true,
      tickfont: { color: theme.muted },
    };
  }

  private updateVisibleSummary(visibleCount: number): void {
    const total = this.loaded?.joined.length ?? 0;
    this.visibleCountElement.textContent = `${visibleCount.toLocaleString()} visible`;
    this.filterSummaryElement.textContent = visibleCount === total
      ? "All samples"
      : `${visibleCount.toLocaleString()} of ${total.toLocaleString()}`;
  }

  private clearSweepPlots(): void {
    if (!this.sweepElement) {
      return;
    }

    this.sweepElement
      .querySelectorAll<HTMLElement>(".sweep-plot")
      .forEach((plot) => {
        try {
          PLOTLY.purge(plot);
        } catch {
          // The node may have been created but not initialized by Plotly yet.
        }
      });

    this.sweepElement.replaceChildren();
  }

  private showMainPlot(): void {
    this.clearSweepPlots();
    this.showingSweep = false;
    this.plotElement.classList.remove("d-none");

    if (this.sweepElement) {
      this.sweepElement.classList.add("d-none");
    }
  }
}

const workspace2d = new PlotWorkspace(2, {
  pcSelects: "pc-selects-2d",
  colorBy: "colorBy-2d",
  filters: "filters-2d",
  filterSummary: "filter-summary-2d",
  plot: "plot-2d",
  plotButton: "plotBtn-2d",
  plotTitle: "plot-title-2d",
  visibleCount: "visible-count-2d",
  showReferences: "show-references-2d",
  sweep: "sweep-2d",
  sweepButton: "sweepBtn-2d",
});

const workspace3d = new PlotWorkspace(3, {
  pcSelects: "pc-selects-3d",
  colorBy: "colorBy-3d",
  filters: "filters-3d",
  filterSummary: "filter-summary-3d",
  plot: "plot-3d",
  plotButton: "plotBtn-3d",
  plotTitle: "plot-title-3d",
  visibleCount: "visible-count-3d",
  showReferences: "show-references-3d",
});

function isThemePreference(value: string | undefined): value is ThemePreference {
  return value === "default" || value === "light" || value === "dark";
}

function getThemePreference(): ThemePreference {
  const value = document.documentElement.dataset.themePreference;
  return isThemePreference(value) ? value : "default";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "default") {
    return SYSTEM_DARK_QUERY.matches ? "dark" : "light";
  }

  return preference;
}

function saveThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable in hardened or private browsing contexts.
  }
}

function applyThemePreference(
  preference: ThemePreference,
  persist: boolean,
): void {
  const resolved = resolveTheme(preference);

  document.documentElement.dataset.themePreference = preference;
  document.documentElement.setAttribute("data-bs-theme", resolved);

  appLogo.src = `${import.meta.env.BASE_URL}${
    resolved === "dark" ? "logo-darkmode.svg" : "logo-whitemode.svg"
  }`;

  for (const button of themeChoiceButtons) {
    const active = button.dataset.themeChoice === preference;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  if (persist) {
    saveThemePreference(preference);
  }

  vertebraViewer.setTheme(resolved);

  window.requestAnimationFrame(() => {
    const refreshes: Promise<void>[] = [plotActiveWorkspace()];

    if (activeLoaded !== null) {
      refreshes.push(renderPcaAnalytics(activeLoaded, activePcaAnalytics));
    }

    void Promise.all(refreshes)
      .then(() => {
        const target = getActiveWorkspaceTarget();
        if (target === "#pca-2d-pane") {
          workspace2d.resize();
        } else if (target === "#pca-3d-pane") {
          workspace3d.resize();
        } else if (target === "#analytics-pane") {
          PLOTLY.Plots.resize(variancePlotElement);
        } else if (target === "#mesh-pane") {
          vertebraViewer.refreshViewport();
        }
      })
      .catch(showError);
  });
}

function bindThemeControls(): void {
  applyThemePreference(getThemePreference(), false);

  for (const button of themeChoiceButtons) {
    button.addEventListener("click", () => {
      const preference = button.dataset.themeChoice;
      if (isThemePreference(preference)) {
        applyThemePreference(preference, true);
      }
    });
  }

  SYSTEM_DARK_QUERY.addEventListener("change", () => {
    if (getThemePreference() === "default") {
      applyThemePreference("default", false);
    }
  });
}

let datasets: DatasetDef[] = [];
let datasetLoadGeneration = 0;
let activeLoaded: Loaded | null = null;
let activePcaAnalytics: PcaAnalyticsData | null = null;
let activeDatasetDefinition: DatasetDef | null = null;
const loadedDatasetCache = new Map<string, Promise<Loaded>>();
const pcaAnalyticsCache = new Map<string, Promise<PcaAnalyticsData | null>>();
const pcaSampleMetricsCache = new Map<string, Promise<PcaSampleMetricsData | null>>();
const subjectMeshCatalog = new Map<
  string,
  Map<string, SubjectMeshEntry[]>
>();
let subjectMetadataById = new Map<string, MetaRow>();
let subjectLoadGeneration = 0;

function sanitiseFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "vertebra";
}

function getLoadedDataset(definition: DatasetDef): Promise<Loaded> {
  const cached = loadedDatasetCache.get(definition.key);

  if (cached) {
    return cached;
  }

  const loading = loadAll(definition).catch((error) => {
    loadedDatasetCache.delete(definition.key);
    throw error;
  });

  loadedDatasetCache.set(definition.key, loading);
  return loading;
}

function validatePcaAnalytics(
  value: PcaAnalyticsData,
  source: string,
): PcaAnalyticsData {
  const count = Number(value.componentCount);
  const arrays = [
    value.explainedVariance,
    value.explainedVarianceRatio,
    value.cumulativeExplainedVarianceRatio,
    value.standardDeviations,
  ];

  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`Invalid PCA analytics componentCount in ${source}.`);
  }

  if (arrays.some((array) => !Array.isArray(array) || array.length !== count)) {
    throw new Error(`PCA analytics arrays in ${source} do not match componentCount.`);
  }

  return value;
}

function getPcaAnalytics(
  definition: DatasetDef,
): Promise<PcaAnalyticsData | null> {
  const cached = pcaAnalyticsCache.get(definition.key);

  if (cached) {
    return cached;
  }

  const filename = definition.analytics ?? `pca_analytics_${definition.key}.json`;
  const url = `${DATA_ROOT}/${filename}`;
  const loading = fetch(url)
    .then(async (response) => {
      if (response.status === 404 && definition.analytics === undefined) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
      }

      return validatePcaAnalytics(
        await response.json() as PcaAnalyticsData,
        url,
      );
    })
    .catch((error) => {
      pcaAnalyticsCache.delete(definition.key);

      if (definition.analytics === undefined) {
        console.warn(
          `No precomputed PCA analytics were loaded for '${definition.key}'. ` +
          "Falling back to the browser score matrix.",
          error,
        );
        return null;
      }

      throw error;
    });

  pcaAnalyticsCache.set(definition.key, loading);
  return loading;
}


function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : null;
}

function validatePcaSampleMetrics(
  value: PcaSampleMetricsData,
  source: string,
): PcaSampleMetricsData {
  if (value.formatVersion !== 1) {
    throw new Error(`Unsupported sample-metrics formatVersion in ${source}.`);
  }

  if (!Array.isArray(value.samples) || !Array.isArray(value.references)) {
    throw new Error(`Invalid sample metrics arrays in ${source}.`);
  }

  value.samples = value.samples.map((sample, index) => ({
    rowIndex: Number.isInteger(Number(sample.rowIndex)) ? Number(sample.rowIndex) : index,
    caseId: String(sample.caseId ?? ""),
    level: String(sample.level ?? ""),
    gender: sample.gender === null || sample.gender === undefined
      ? null
      : String(sample.gender),
    age: finiteOrNull(sample.age),
    mahalanobisAppropriate: finiteOrNull(sample.mahalanobisAppropriate),
    mahalanobisReference: sample.mahalanobisReference === null || sample.mahalanobisReference === undefined
      ? null
      : String(sample.mahalanobisReference),
    referenceSampleCount: finiteOrNull(sample.referenceSampleCount),
    surfaceAreaMm2: finiteOrNull(sample.surfaceAreaMm2),
    volumeCc: finiteOrNull(sample.volumeCc),
  }));

  value.references = value.references.map((reference) => ({
    level: String(reference.level ?? ""),
    gender: reference.gender === "Male" || reference.gender === "Female"
      ? reference.gender
      : "All",
    sampleCount: Number(reference.sampleCount) || 0,
    pcScores: Array.isArray(reference.pcScores)
      ? reference.pcScores.map(Number)
      : [],
  }));

  return value;
}

function getPcaSampleMetrics(
  definition: DatasetDef,
): Promise<PcaSampleMetricsData | null> {
  const cached = pcaSampleMetricsCache.get(definition.key);
  if (cached) {
    return cached;
  }

  const filename = definition.sampleMetrics ?? `pca_sample_metrics_${definition.key}.json`;
  const url = `${DATA_ROOT}/${filename}`;
  const loading = fetch(url)
    .then(async (response) => {
      if (response.status === 404 && definition.sampleMetrics === undefined) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
      }
      return validatePcaSampleMetrics(
        await response.json() as PcaSampleMetricsData,
        url,
      );
    })
    .catch((error) => {
      pcaSampleMetricsCache.delete(definition.key);
      if (definition.sampleMetrics === undefined) {
        console.warn(
          `No precomputed sample metrics were loaded for '${definition.key}'. ` +
          "Surface-area, volume and appropriate Mahalanobis colouring are disabled.",
          error,
        );
        return null;
      }
      throw error;
    });

  pcaSampleMetricsCache.set(definition.key, loading);
  return loading;
}

function alignPcaSampleMetrics(
  metrics: PcaSampleMetricsData | null,
  loaded: Loaded,
  datasetKey: string,
): PcaSampleMetricsData | null {
  if (metrics === null) {
    return null;
  }

  if (metrics.samples.length !== loaded.X.length) {
    throw new Error(
      `Sample metrics for '${datasetKey}' contain ${metrics.samples.length} rows, ` +
      `but the PCA data contain ${loaded.X.length}.`,
    );
  }

  const aligned = new Array<PcaSampleMetric>(loaded.X.length);
  for (const metric of metrics.samples) {
    if (metric.rowIndex < 0 || metric.rowIndex >= aligned.length) {
      throw new Error(`Sample metrics for '${datasetKey}' contain an invalid rowIndex.`);
    }
    aligned[metric.rowIndex] = metric;
  }

  for (let index = 0; index < aligned.length; index += 1) {
    const metric = aligned[index];
    const row = loaded.joined[index];
    if (!metric) {
      throw new Error(`Sample metrics for '${datasetKey}' are missing row ${index}.`);
    }
    if (metric.caseId && metric.caseId !== row.case_id) {
      throw new Error(
        `Sample-metrics alignment error for '${datasetKey}' at row ${index}: ` +
        `${metric.caseId} does not match ${row.case_id}.`,
      );
    }
  }

  return { ...metrics, samples: aligned };
}

function genderAbbreviation(gender: string | null): string | null {
  if (gender === "Male") {
    return "M";
  }

  if (gender === "Female") {
    return "F";
  }

  return null;
}

function formatSubjectAge(age: number | null): string | null {
  if (age === null || !Number.isFinite(age)) {
    return null;
  }

  return Number.isInteger(age) ? String(age) : age.toFixed(1);
}

function subjectDisplayLabel(subjectId: string): string {
  const metadata =
    subjectMetadataById.get(subjectId) ??
    activeLoaded?.metaById.get(subjectId);
  const gender = genderAbbreviation(metadata?.gender ?? null);
  const age = formatSubjectAge(metadata?.age ?? null);

  return [subjectId, gender, age]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function resetSubjectSelection(resetMesh = true): void {
  subjectLoadGeneration += 1;
  vertebraSubjectSelect.value = "";
  vertebraLevelSelect.replaceChildren();

  const option = document.createElement("option");
  option.value = "";
  option.textContent = "Select a subject first";
  vertebraLevelSelect.appendChild(option);
  vertebraLevelSelect.disabled = true;
  vertebraResetSubjectButton.disabled = true;

  if (resetMesh) {
    vertebraViewer.reset();
  }
}

function populateSubjectOptions(): void {
  vertebraSubjectSelect.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a subject";
  vertebraSubjectSelect.appendChild(placeholder);

  const subjects = Array.from(subjectMeshCatalog.keys()).sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true }),
  );

  for (const subjectId of subjects) {
    const option = document.createElement("option");
    option.value = subjectId;
    option.textContent = subjectDisplayLabel(subjectId);
    vertebraSubjectSelect.appendChild(option);
  }

  vertebraSubjectSelect.disabled = subjects.length === 0;
  placeholder.textContent = subjects.length === 0
    ? "No generator-backed subjects found"
    : "Select a subject";
}

function populateLevelOptions(subjectId: string): void {
  vertebraLevelSelect.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a vertebral level";
  vertebraLevelSelect.appendChild(placeholder);

  const levels = subjectMeshCatalog.get(subjectId);

  if (!levels) {
    vertebraLevelSelect.disabled = true;
    return;
  }

  for (const level of Array.from(levels.keys()).sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true }),
  )) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    vertebraLevelSelect.appendChild(option);
  }

  vertebraLevelSelect.disabled = false;
}

async function buildSubjectMeshCatalog(): Promise<void> {
  subjectMeshCatalog.clear();
  vertebraSubjectSelect.disabled = true;

  subjectMetadataById = activeLoaded?.metaById ?? new Map<string, MetaRow>();

  if (subjectMetadataById.size === 0) {
    try {
      subjectMetadataById = await loadMeta(`${DATA_ROOT}/meta.csv`);
    } catch (error) {
      console.warn("Could not load subject metadata for display labels.", error);
    }
  }

  const generatorDatasets = datasets.filter(
    (definition): definition is DatasetDef & { generator: string } =>
      typeof definition.generator === "string",
  );

  const indexedDatasets = (await Promise.all(
    generatorDatasets.map(async (definition) => {
      try {
        const [levels, manifest] = await Promise.all([
          loadLevelsCsv(`${DATA_ROOT}/${definition.labels}`),
          fetchJson<{ level?: unknown }>(`${DATA_ROOT}/${definition.generator}`),
        ]);
        const generatorLevel = manifest.level === null || manifest.level === undefined
          ? definition.key
          : String(manifest.level).trim() || definition.key;

        return { definition, levels, generatorLevel };
      } catch (error) {
        console.warn(
          `Could not index subjects for dataset '${definition.key}'.`,
          error,
        );
        return null;
      }
    }),
  )).filter((entry) => entry !== null);

  for (const { definition, levels, generatorLevel } of indexedDatasets) {
    for (const [rowIndex, row] of levels.entries()) {
      // The CSV level is the anatomical vertebral level represented by this
      // PCA row. The manifest level identifies only the common mesh template
      // on which that anatomy is reconstructed. A C5-template dataset can
      // therefore legitimately contain C3, C4, C5, C6, and C7 vertebrae.
      const level = row.level ?? generatorLevel;
      let subjectLevels = subjectMeshCatalog.get(row.case_id);

      if (!subjectLevels) {
        subjectLevels = new Map<string, SubjectMeshEntry[]>();
        subjectMeshCatalog.set(row.case_id, subjectLevels);
      }

      let entries = subjectLevels.get(level);

      if (!entries) {
        entries = [];
        subjectLevels.set(level, entries);
      }

      if (!entries.some(
        (entry) =>
          entry.datasetKey === definition.key &&
          entry.rowIndex === rowIndex,
      )) {
        entries.push({
          datasetKey: definition.key,
          rowIndex,
          caseId: row.case_id,
          level,
          templateLevel: generatorLevel,
        });
      }
    }
  }

  populateSubjectOptions();
}

async function applySelectedSubjectLevel(): Promise<void> {
  vertebraViewer.stopAnimation();
  const subjectId = vertebraSubjectSelect.value;
  const level = vertebraLevelSelect.value;

  if (!subjectId || !level) {
    return;
  }

  const entries = subjectMeshCatalog.get(subjectId)?.get(level);

  if (!entries || entries.length === 0) {
    throw new Error(`No PCA entry was found for subject ${subjectId} at ${level}.`);
  }

  // Prefer the currently active template so choosing another anatomical level
  // does not unexpectedly switch datasets. If it is unavailable, prefer a
  // same-level template, then fall back to the first compatible entry.
  const entry =
    entries.find(
      (candidate) => candidate.datasetKey === activeDatasetDefinition?.key,
    ) ??
    entries.find(
      (candidate) => candidate.templateLevel === level,
    ) ??
    entries[0];

  const currentGeneration = ++subjectLoadGeneration;
  clearError();
  vertebraSubjectSelect.disabled = true;
  vertebraLevelSelect.disabled = true;
  vertebraResetSubjectButton.disabled = true;

  try {
    if (elDataset.value !== entry.datasetKey || activeDatasetDefinition?.key !== entry.datasetKey) {
      elDataset.value = entry.datasetKey;
      await loadSelectedDataset();
    }

    if (currentGeneration !== subjectLoadGeneration) {
      return;
    }

    if (!activeLoaded || activeDatasetDefinition?.key !== entry.datasetKey) {
      throw new Error(`Dataset '${entry.datasetKey}' could not be activated.`);
    }

    let rowIndex = entry.rowIndex;
    const alignedRow = activeLoaded.levels[rowIndex];

    if (
      !alignedRow ||
      alignedRow.case_id !== entry.caseId ||
      (alignedRow.level !== null && alignedRow.level !== entry.level)
    ) {
      rowIndex = activeLoaded.levels.findIndex(
        (row) =>
          row.case_id === entry.caseId &&
          (row.level === null || row.level === entry.level),
      );
    }

    if (rowIndex < 0 || !activeLoaded.X[rowIndex]) {
      throw new Error(
        `The PCA score row for subject ${subjectId} at ${level} is missing.`,
      );
    }

    vertebraViewer.setPcaScores(
      activeLoaded.X[rowIndex],
      15,
      subjectDisplayLabel(subjectId),
      entry.level,
    );
    vertebraDownloadButton.disabled = false;
  } finally {
    if (currentGeneration === subjectLoadGeneration) {
      vertebraSubjectSelect.disabled = false;
      vertebraLevelSelect.disabled = false;
      vertebraResetSubjectButton.disabled = false;
    }
  }
}

vertebraSubjectSelect.addEventListener("change", () => {
  vertebraViewer.stopAnimation();
  const subjectId = vertebraSubjectSelect.value;

  if (!subjectId) {
    resetSubjectSelection(true);
    return;
  }

  populateLevelOptions(subjectId);
  vertebraResetSubjectButton.disabled = false;
});

vertebraLevelSelect.addEventListener("change", () => {
  void applySelectedSubjectLevel().catch((error) => {
    console.error(error);
    showError(error);
  });
});

vertebraResetSubjectButton.addEventListener("click", () => {
  vertebraViewer.stopAnimation();
  resetSubjectSelection(true);
});


function columnStatistics(X: number[][]): { means: number[]; variances: number[]; stds: number[] } {
  const d = X[0]?.length ?? 0;
  const means = Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j += 1) means[j] += row[j];
  for (let j = 0; j < d; j += 1) means[j] /= Math.max(1, X.length);
  const variances = Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j += 1) variances[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < d; j += 1) variances[j] /= Math.max(1, X.length - 1);
  return { means, variances, stds: variances.map(Math.sqrt) };
}

function updateComponentMetrics(
  loaded: Loaded,
  analytics: PcaAnalyticsData | null,
  generatorComponentCount?: number,
): void {
  const totalComponentCount = analytics?.componentCount ?? loaded.X[0].length;
  const availableComponentCount = Math.min(
    loaded.X[0].length,
    totalComponentCount,
  );
  const usedComponentCount = Math.min(
    generatorComponentCount ?? APP_COMPONENT_LIMIT,
    APP_COMPONENT_LIMIT,
    availableComponentCount,
  );

  elComponentCount.textContent = `${usedComponentCount.toLocaleString()}/${totalComponentCount.toLocaleString()}`;

  const cumulativeRatio = analytics !== null && usedComponentCount > 0
    ? analytics.cumulativeExplainedVarianceRatio[usedComponentCount - 1]
    : undefined;

  elCumulativeVariance.textContent = Number.isFinite(cumulativeRatio)
    ? `${(Number(cumulativeRatio) * 100).toFixed(1)}%`
    : "—";
}

async function renderPcaAnalytics(
  loaded: Loaded,
  analytics: PcaAnalyticsData | null,
): Promise<void> {
  let variances: number[];
  let ratios: number[];
  let cumulativeRatios: number[];
  let stds: number[];

  if (analytics !== null) {
    variances = analytics.explainedVariance;
    ratios = analytics.explainedVarianceRatio;
    cumulativeRatios = analytics.cumulativeExplainedVarianceRatio;
    stds = analytics.standardDeviations;
  } else {
    const statistics = columnStatistics(loaded.X);
    variances = statistics.variances;
    stds = statistics.stds;
    const total = variances.reduce((sum, value) => sum + value, 0) || 1;
    ratios = variances.map((value) => value / total);
    let cumulative = 0;
    cumulativeRatios = ratios.map((value) => cumulative += value);
  }

  const labels = variances.map((_, index) => `PC${index}`);
  const theme = getPlotTheme();
  const appComponentCount = Math.min(
    APP_COMPONENT_LIMIT,
    loaded.X[0].length,
  );
  const initialVisibleComponentCount = Math.min(
    variances.length,
    Math.max(1, appComponentCount * 2),
  );

  await PLOTLY.react(
    variancePlotElement,
    [
      {
        type: "bar",
        x: labels,
        y: ratios.map((value) => value * 100),
        name: "Individual",
        marker: { color: theme.primary },
      },
      {
        type: "scatter",
        x: labels,
        y: cumulativeRatios.map((value) => value * 100),
        name: "Cumulative",
        mode: "lines",
        yaxis: "y2",
        line: { width: 2 },
      },
    ],
    {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: theme.surface,
      font: { color: theme.ink },
      margin: { l: 58, r: 58, t: 20, b: 65 },
      xaxis: {
        title: "Principal component",
        type: "category",
        range: [-0.5, initialVisibleComponentCount - 0.5],
        gridcolor: theme.line,
        rangeslider: { visible: variances.length > initialVisibleComponentCount, thickness: 0.08 },
      },
      yaxis: { title: "Explained variance (%)", gridcolor: theme.line },
      yaxis2: {
        title: "Cumulative (%)",
        overlaying: "y",
        side: "right",
        range: [0, 105],
      },
      legend: { orientation: "h" },
    },
    PLOT_CONFIG,
  );

  eigenvalueTableBody.replaceChildren(
    ...variances.map((value, index) => {
      const row = document.createElement("tr");
      const values = [
        `PC${index}`,
        value.toPrecision(6),
        stds[index].toPrecision(6),
        `${(ratios[index] * 100).toFixed(2)}%`,
        `${(cumulativeRatios[index] * 100).toFixed(2)}%`,
      ];

      for (const text of values) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.appendChild(cell);
      }

      return row;
    }),
  );
}

function meanZScores(predicate?: (row: JoinedRow) => boolean): number[] | null {
  if (!activeLoaded) return null;
  const indices = activeLoaded.joined.map((row, i) => predicate?.(row) ?? true ? i : -1).filter((i) => i >= 0);
  if (!indices.length) return null;
  const stats = columnStatistics(activeLoaded.X);
  return stats.means.map((_, pc) => {
    const mean = indices.reduce((sum, i) => sum + activeLoaded!.X[i][pc], 0) / indices.length;
    return stats.stds[pc] > 0 ? mean / stats.stds[pc] : 0;
  });
}

function mahalanobisForCurrent(predicate?: (row: JoinedRow) => boolean): number | null {
  if (!activeLoaded) return null;
  const indices = activeLoaded.joined.map((row, i) => predicate?.(row) ?? true ? i : -1).filter((i) => i >= 0);
  if (indices.length < 2) return null;
  const z = vertebraViewer.getZScores();
  const d = Math.min(z.length, activeLoaded.X[0].length);
  const subgroup = indices.map((i) => activeLoaded!.X[i]);
  const stats = columnStatistics(subgroup);
  const globalStds = columnStatistics(activeLoaded.X).stds;
  let squared = 0;
  for (let pc = 0; pc < d; pc += 1) {
    const currentRaw = z[pc] * globalStds[pc];
    const variance = stats.variances[pc];
    if (variance > 1e-12) squared += ((currentRaw - stats.means[pc]) ** 2) / variance;
  }
  return Math.sqrt(squared);
}

function formatMahalanobis(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function createValidityMetric(
  label: string,
  predicate?: (row: JoinedRow) => boolean,
): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "validity-metric";

  const span = document.createElement("span");
  span.textContent = label;

  const strong = document.createElement("strong");
  strong.textContent = formatMahalanobis(
    mahalanobisForCurrent(predicate),
  );

  box.append(span, strong);
  return box;
}

function updateMahalanobisSummary(): void {
  if (activeLoaded === null) {
    mahalanobisSummary.textContent =
      "Generate or select a shape to calculate validity.";
    return;
  }

  const overviewSection = document.createElement("section");
  overviewSection.className = "validity-section";

  const overviewHeading = document.createElement("h3");
  overviewHeading.textContent = "Whole-cohort comparison";

  const overviewGrid = document.createElement("div");
  overviewGrid.className = "validity-overview-grid";
  overviewGrid.append(
    createValidityMetric("All samples"),
    createValidityMetric("Male", (row) => row.gender === "Male"),
    createValidityMetric("Female", (row) => row.gender === "Female"),
  );

  overviewSection.append(overviewHeading, overviewGrid);

  const levelSection = document.createElement("section");
  levelSection.className = "validity-section";

  const levelHeading = document.createElement("h3");
  levelHeading.textContent = "Anatomical-level comparison";

  const tableContainer = document.createElement("div");
  tableContainer.className = "table-responsive";

  const table = document.createElement("table");
  table.className = "table mahalanobis-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");

  for (const heading of ["Level", "Female", "Male"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    headRow.appendChild(cell);
  }

  head.appendChild(headRow);

  const body = document.createElement("tbody");
  const levels = Array.from(
    new Set(
      activeLoaded.joined
        .map((row) => row.level)
        .filter((level): level is string => Boolean(level)),
    ),
  ).sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );

  for (const level of levels) {
    const row = document.createElement("tr");
    const levelCell = document.createElement("th");
    levelCell.scope = "row";
    levelCell.textContent = level;

    const femaleCell = document.createElement("td");
    femaleCell.textContent = formatMahalanobis(
      mahalanobisForCurrent(
        (candidate) => candidate.level === level && candidate.gender === "Female",
      ),
    );

    const maleCell = document.createElement("td");
    maleCell.textContent = formatMahalanobis(
      mahalanobisForCurrent(
        (candidate) => candidate.level === level && candidate.gender === "Male",
      ),
    );

    row.append(levelCell, femaleCell, maleCell);
    body.appendChild(row);
  }

  if (levels.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.className = "validity-empty";
    cell.textContent = "No anatomical levels are available for this template.";
    row.appendChild(cell);
    body.appendChild(row);
  }

  table.append(head, body);
  tableContainer.appendChild(table);
  levelSection.append(levelHeading, tableContainer);

  mahalanobisSummary.replaceChildren(
    overviewSection,
    levelSection,
  );
}

function populateAnimatePc(count: number): void {
  animatePcSelect.replaceChildren(...Array.from({ length: Math.min(count, 15) }, (_, i) => {
    const option = document.createElement("option"); option.value = String(i); option.textContent = `PC${i}`; return option;
  }));
}

async function selectSampleFromPlot(rowIndex: number): Promise<void> {
  if (!activeLoaded?.X[rowIndex]) {
    return;
  }

  const row = activeLoaded.joined[rowIndex];
  const meshTab = requiredElement("mesh-tab", HTMLButtonElement);

  vertebraViewer.stopAnimation();
  activateWorkspaceTab(meshTab, "push");
  vertebraViewer.setPcaScores(
    activeLoaded.X[rowIndex],
    15,
    subjectDisplayLabel(row.case_id),
    row.level ?? undefined,
  );

  vertebraSubjectSelect.value = row.case_id;
  populateLevelOptions(row.case_id);

  if (row.level) {
    vertebraLevelSelect.value = row.level;
  }

  vertebraResetSubjectButton.disabled = false;
  vertebraDownloadButton.disabled = false;
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

randomButton.addEventListener("click", () => {
  vertebraViewer.randomise();
});

animatePcSelect.addEventListener("change", () => {
  vertebraViewer.stopAnimation();
});

animatePcButton.addEventListener("click", () => {
  if (vertebraViewer.isAnimating()) {
    vertebraViewer.stopAnimation();
    return;
  }

  vertebraViewer.animatePc(Number(animatePcSelect.value));
});

differenceReferenceSelect.addEventListener("change", () => {
  vertebraViewer.stopAnimation();
  const value = differenceReferenceSelect.value;
  const reference = value === "average"
    ? meanZScores()
    : value === "male"
      ? meanZScores((row) => row.gender === "Male")
      : value === "female"
        ? meanZScores((row) => row.gender === "Female")
        : null;
  vertebraViewer.setReferenceZScores(reference);
});

pcValuesDownloadButton.addEventListener("click", () => {
  vertebraViewer.stopAnimation();
  downloadJson(
    `${activeDatasetDefinition?.key ?? "vertebra"}-pc-values.json`,
    {
      formatVersion: 1,
      dataset: activeDatasetDefinition?.key ?? null,
      valuesType: "zScores",
      pcValues: vertebraViewer.getZScores(),
      createdAt: new Date().toISOString(),
    },
  );
});

pcValuesLoadInput.addEventListener("change", async () => {
  vertebraViewer.stopAnimation();
  const file = pcValuesLoadInput.files?.[0];

  if (!file) {
    return;
  }

  try {
    const parsed = JSON.parse(await file.text()) as {
      dataset?: string;
      pcValues?: number[];
    };

    if (!Array.isArray(parsed.pcValues)) {
      throw new Error("The JSON file does not contain a pcValues array.");
    }

    if (parsed.dataset && parsed.dataset !== elDataset.value) {
      elDataset.value = parsed.dataset;
      await loadSelectedDataset();
    }

    vertebraViewer.setZScores(
      parsed.pcValues,
      "Loaded PCA values from JSON.",
    );
  } finally {
    pcValuesLoadInput.value = "";
  }
});

function getActiveWorkspaceTarget(): string | null {
  const activeTab = document.querySelector<HTMLElement>(
    "#workspace-tabs [data-workspace-target].active",
  );

  return activeTab?.getAttribute("data-workspace-target") ?? null;
}

async function plotActiveWorkspace(): Promise<void> {
  const target = getActiveWorkspaceTarget();

  if (target === "#pca-3d-pane") {
    await workspace3d.refreshCurrentView();
  } else if (target === "#pca-2d-pane") {
    await workspace2d.refreshCurrentView();
  }
}

async function loadSelectedDataset(): Promise<void> {
  vertebraViewer.stopAnimation();
  const currentGeneration = ++datasetLoadGeneration;
  const key = elDataset.value;
  const definition = datasets.find((dataset) => dataset.key === key);

  if (!definition) {
    throw new Error(`Dataset '${key}' was not found.`);
  }

  clearError();
  elDataset.disabled = true;
  setDatasetStatus("loading", "Loading");
  elSampleCount.textContent = "—";
  elComponentCount.textContent = "—";
  elCumulativeVariance.textContent = "—";
  elGeneratorState.textContent = definition.generator ? "Loading…" : "Unavailable";

  try {
    const [loaded, analytics, rawSampleMetrics] = await Promise.all([
      getLoadedDataset(definition),
      getPcaAnalytics(definition),
      getPcaSampleMetrics(definition),
    ]);
    const sampleMetrics = alignPcaSampleMetrics(
      rawSampleMetrics,
      loaded,
      definition.key,
    );

    if (currentGeneration !== datasetLoadGeneration) {
      return;
    }

    if (loaded.X.length === 0 || loaded.X[0].length === 0) {
      throw new Error(`Dataset '${key}' contains no PCA data.`);
    }

    activeLoaded = loaded;
    activePcaAnalytics = analytics;
    activeDatasetDefinition = definition;

    workspace2d.setLoaded(loaded, sampleMetrics);
    workspace3d.setLoaded(loaded, sampleMetrics);
    await renderPcaAnalytics(loaded, analytics);
    populateAnimatePc(loaded.X[0].length);

    elSampleCount.textContent = loaded.X.length.toLocaleString();
    updateComponentMetrics(loaded, analytics);

    await plotActiveWorkspace();

    if (definition.generator) {
      try {
        await vertebraViewer.load(`${DATA_ROOT}/${definition.generator}`);
        updateComponentMetrics(
          loaded,
          analytics,
          vertebraViewer.getComponentCount(),
        );
        elGeneratorState.textContent = "Available";
        vertebraDownloadButton.disabled = false;
      } catch (error) {
        console.error(error);
        elGeneratorState.textContent = "Load error";
        vertebraViewer.clear("The mesh generator could not be loaded for this dataset.");
        vertebraDownloadButton.disabled = true;
        showError(
          error instanceof Error
            ? `PCA data loaded, but the mesh generator failed: ${error.message}`
            : "PCA data loaded, but the mesh generator failed.",
        );
      }
    } else {
      elGeneratorState.textContent = "Unavailable";
      vertebraViewer.clear(`No vertebra generator has been exported for ${definition.key}.`);
      vertebraDownloadButton.disabled = true;
    }

    setDatasetStatus("ready", "Ready");
  } catch (error) {
    if (currentGeneration !== datasetLoadGeneration) {
      return;
    }

    console.error(error);
    setDatasetStatus("error", "Error");
    showError(error);
    throw error;
  } finally {
    if (currentGeneration === datasetLoadGeneration) {
      elDataset.disabled = false;
    }
  }
}

type WorkspaceTarget = "#pca-2d-pane" | "#pca-3d-pane" | "#analytics-pane" | "#mesh-pane";
type WorkspaceHistoryMode = "none" | "replace" | "push";

type WorkspaceHistoryState = {
  workspaceTarget?: WorkspaceTarget;
};

function isWorkspaceTarget(value: string | null): value is WorkspaceTarget {
  return value === "#pca-2d-pane" || value === "#pca-3d-pane" || value === "#analytics-pane" || value === "#mesh-pane";
}

function refreshWorkspace(target: WorkspaceTarget): void {
  window.requestAnimationFrame(() => {
    if (target === "#pca-2d-pane") {
      void workspace2d.refreshCurrentView()
        .then(() => workspace2d.resize())
        .catch(showError);
    } else if (target === "#pca-3d-pane") {
      void workspace3d.refreshCurrentView()
        .then(() => workspace3d.resize())
        .catch(showError);
    } else if (target === "#analytics-pane") {
      if (activeLoaded !== null) {
        void renderPcaAnalytics(activeLoaded, activePcaAnalytics)
          .then(() => PLOTLY.Plots.resize(variancePlotElement))
          .catch(showError);
      }
    } else {
      vertebraViewer.refreshViewport();
    }
  });
}

function updateWorkspaceHistory(
  target: WorkspaceTarget,
  mode: Exclude<WorkspaceHistoryMode, "none">,
): void {
  const currentState =
    history.state !== null && typeof history.state === "object"
      ? history.state as Record<string, unknown>
      : {};
  const nextState: WorkspaceHistoryState & Record<string, unknown> = {
    ...currentState,
    workspaceTarget: target,
  };

  if (mode === "push") {
    history.pushState(nextState, document.title);
  } else {
    history.replaceState(nextState, document.title);
  }
}

function activateWorkspaceTab(
  tab: HTMLButtonElement,
  historyMode: WorkspaceHistoryMode = "none",
): void {
  const target = tab.getAttribute("data-workspace-target");

  if (!isWorkspaceTarget(target)) {
    return;
  }

  if (historyMode !== "none") {
    updateWorkspaceHistory(target, historyMode);
  }

  if (target !== "#mesh-pane") {
    vertebraViewer.stopAnimation();
  }

  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "#workspace-tabs [data-workspace-target]",
    ),
  );
  const panes = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#workspace-tab-content > [role='tabpanel']",
    ),
  );

  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.classList.toggle("active", selected);
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  }

  for (const pane of panes) {
    const selected = `#${pane.id}` === target;
    pane.classList.toggle("active", selected);
    pane.classList.toggle("show", selected);
    pane.hidden = !selected;
  }

  refreshWorkspace(target);
}

function bindWorkspaceTabs(): void {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "#workspace-tabs [data-workspace-target]",
    ),
  );

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      activateWorkspaceTab(tab, "replace");
    });

    tab.addEventListener("keydown", (event) => {
      const currentIndex = tabs.indexOf(tab);
      let nextIndex: number | null = null;

      if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      }

      if (nextIndex === null) {
        return;
      }

      event.preventDefault();
      const nextTab = tabs[nextIndex];
      nextTab.focus();
      activateWorkspaceTab(nextTab, "replace");
    });
  }

  window.addEventListener("popstate", (event: PopStateEvent) => {
    const state = event.state as WorkspaceHistoryState | null;
    const target = state?.workspaceTarget;

    if (!isWorkspaceTarget(target ?? null)) {
      return;
    }

    const tab = tabs.find(
      (candidate) => candidate.getAttribute("data-workspace-target") === target,
    );

    if (tab) {
      activateWorkspaceTab(tab, "none");
    }
  });

  const initialTab = tabs.find((tab) => tab.classList.contains("active")) ?? tabs[0];

  if (initialTab) {
    activateWorkspaceTab(initialTab, "replace");
  }
}

async function main(): Promise<void> {
  bindThemeControls();
  bindWorkspaceTabs();

  datasets = await fetchJson<DatasetDef[]>(`${DATA_ROOT}/datasets.json`);

  if (datasets.length === 0) {
    throw new Error("datasets.json does not define any datasets.");
  }

  for (const definition of datasets) {
    const option = document.createElement("option");
    option.value = definition.key;
    option.textContent = templateDisplayLabel(definition.key);
    elDataset.appendChild(option);
  }

  elDataset.addEventListener("change", () => {
    resetSubjectSelection(false);
    void loadSelectedDataset().catch((error) => {
      console.error(error);
    });
  });

  await loadSelectedDataset();
  await buildSubjectMeshCatalog();
}

main().catch((error) => {
  console.error(error);
  setDatasetStatus("error", "Error");
  showError(error);
});

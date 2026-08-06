import {
  CIRCLE_LAYER_HIGH,
  CIRCLE_LAYER_LOW,
  ICON_LAYER_HIGH,
  ICON_LAYER_LOW,
  LABEL_LAYER,
  LABEL_MIN_ZOOM,
  LABEL_PRIORITY_LAYER,
  LIVE_SHAPES_FILL_LAYER,
  LIVE_SHAPES_LINE_LAYER,
  LIVE_SHAPES_SOURCE_ID,
  MAP_LABEL_FONT,
  MARKER_FILTER,
  MARKER_LAYER_IDS,
  SOURCE_ID,
} from "../constants";

/** Minimal MapLibre map surface used by layer helpers. */
type MapLibreMap = {
  isStyleLoaded: () => boolean;
  getLayer: (id: string) => unknown;
  getSource: (id: string) => unknown;
  addSource: (id: string, src: object) => void;
  removeSource: (id: string) => void;
  addLayer: (layer: object, before?: string) => void;
  removeLayer: (id: string) => void;
};

function markerCircleOpacityPaint(): unknown {
  return ["case", ["==", ["get", "showCircle"], 1], 1, 0];
}

function markerIconOpacityPaint(): unknown {
  return [
    "case",
    ["==", ["get", "showCircle"], 1],
    0,
    ["case", ["==", ["get", "iconId"], ""], 0, 1],
  ];
}

function markerCircleLayerSpec(id: string, drawTier: number): object {
  return {
    id,
    type: "circle",
    source: SOURCE_ID,
    filter: [
      "all",
      MARKER_FILTER,
      ["==", ["get", "showCircle"], 1],
      ["==", ["get", "drawTier"], drawTier],
    ],
    layout: {
      "circle-sort-key": ["get", "renderSort"],
    },
    paint: {
      "circle-radius": ["case", ["get", "selected"], 13, 10],
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
      "circle-opacity": markerCircleOpacityPaint(),
    },
  };
}

function markerIconLayerSpec(id: string, drawTier: number): object {
  return {
    id,
    type: "symbol",
    source: SOURCE_ID,
    filter: [
      "all",
      MARKER_FILTER,
      ["!=", ["get", "iconId"], ""],
      ["==", ["get", "drawTier"], drawTier],
    ],
    layout: {
      "icon-image": ["get", "iconId"],
      "icon-size": ["case", ["get", "selected"], 1.05, 0.88],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": ["get", "renderSort"],
    },
    paint: {
      "icon-opacity": markerIconOpacityPaint(),
      "icon-halo-color": "#ffffff",
      "icon-halo-width": 4,
    },
  };
}

function markerLabelLayout(priority: boolean): object {
  return {
    "text-field": [
      "case",
      ["any", ["==", ["get", "showLabel"], 1], ["==", ["get", "showLabel"], true]],
      ["get", "callsign"],
      "",
    ],
    "text-font": MAP_LABEL_FONT,
    "text-size": 12,
    "text-offset": [0, -1.55],
    "text-anchor": "bottom",
    "text-allow-overlap": priority,
    "text-ignore-placement": priority,
    "text-optional": !priority,
    "text-max-width": 12,
    "text-padding": 1.5,
    "text-letter-spacing": 0.01,
    "symbol-sort-key": ["get", "labelSort"],
    "symbol-z-order": "source",
  };
}

const markerLabelPaint = {
  "text-color": "#f8fafc",
  "text-halo-color": "rgba(0, 0, 0, 0.92)",
  "text-halo-width": 2,
  "text-halo-blur": 0.35,
  "text-opacity": 1,
};

export function markerLayersComplete(map: MapLibreMap): boolean {
  return MARKER_LAYER_IDS.every((id) => !!map.getLayer(id));
}

export function removeMarkerLayers(map: MapLibreMap): void {
  for (const id of MARKER_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getLayer(LIVE_SHAPES_FILL_LAYER)) map.removeLayer(LIVE_SHAPES_FILL_LAYER);
  if (map.getLayer(LIVE_SHAPES_LINE_LAYER)) map.removeLayer(LIVE_SHAPES_LINE_LAYER);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  if (map.getSource(LIVE_SHAPES_SOURCE_ID)) map.removeSource(LIVE_SHAPES_SOURCE_ID);
}

export function ensureLiveShapeLayers(map: MapLibreMap): void {
  if (!map.getSource(LIVE_SHAPES_SOURCE_ID)) {
    map.addSource(LIVE_SHAPES_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  const before = map.getLayer(CIRCLE_LAYER_LOW) ? CIRCLE_LAYER_LOW : undefined;
  if (!map.getLayer(LIVE_SHAPES_FILL_LAYER)) {
    map.addLayer(
      {
        id: LIVE_SHAPES_FILL_LAYER,
        type: "fill",
        source: LIVE_SHAPES_SOURCE_ID,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": ["coalesce", ["get", "fill"], "#ffffff"],
          "fill-opacity": ["coalesce", ["get", "fill-opacity"], 0.1],
        },
      } as never,
      before
    );
  }
  if (!map.getLayer(LIVE_SHAPES_LINE_LAYER)) {
    map.addLayer(
      {
        id: LIVE_SHAPES_LINE_LAYER,
        type: "line",
        source: LIVE_SHAPES_SOURCE_ID,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]],
        paint: {
          "line-color": ["coalesce", ["get", "stroke"], "#ffffff"],
          "line-opacity": ["coalesce", ["get", "stroke-opacity"], 0.9],
          "line-width": ["coalesce", ["get", "stroke-width"], 2],
        },
      } as never,
      before
    );
  }
}

export function addMarkerLayers(map: MapLibreMap): boolean {
  if (!map.isStyleLoaded()) return false;
  if (markerLayersComplete(map)) return true;

  if (map.getSource(SOURCE_ID)) {
    removeMarkerLayers(map);
  }

  map.addSource(SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer(markerCircleLayerSpec(CIRCLE_LAYER_LOW, 0) as never);
  map.addLayer(markerIconLayerSpec(ICON_LAYER_LOW, 0) as never);
  map.addLayer(markerCircleLayerSpec(CIRCLE_LAYER_HIGH, 1) as never);
  map.addLayer(markerIconLayerSpec(ICON_LAYER_HIGH, 1) as never);

  map.addLayer({
    id: LABEL_LAYER,
    type: "symbol",
    source: SOURCE_ID,
    minzoom: LABEL_MIN_ZOOM,
    filter: [
      "all",
      MARKER_FILTER,
      ["==", ["get", "showLabel"], 1],
      ["!", ["get", "selected"]],
      ["!", ["get", "locked"]],
    ],
    layout: markerLabelLayout(false),
    paint: markerLabelPaint,
  } as never);

  map.addLayer({
    id: LABEL_PRIORITY_LAYER,
    type: "symbol",
    source: SOURCE_ID,
    filter: [
      "all",
      MARKER_FILTER,
      ["any", ["get", "selected"], ["get", "locked"]],
    ],
    layout: markerLabelLayout(true),
    paint: markerLabelPaint,
  } as never);

  ensureLiveShapeLayers(map);
  return true;
}

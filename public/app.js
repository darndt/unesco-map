(() => {
  "use strict";

  const COLORS = { Cultural: "#e0781f", Natural: "#2a9d5c", Mixed: "#7e57c2" };
  const DANGER = "#d62839";
  const STYLE = "https://tiles.openfreemap.org/styles/liberty";

  const state = {
    categories: new Set(["Cultural", "Natural", "Mixed"]),
    dangerOnly: false,
    features: [],
    popup: null,
    hoverId: null,
    previewId: null,
  };

  const tooltip = new maplibregl.Popup({
    className: "site-tooltip", closeButton: false, closeOnClick: false, offset: 10, maxWidth: "260px",
  });

  const map = new maplibregl.Map({
    container: "map",
    style: STYLE,
    center: [15, 30],
    zoom: window.innerWidth <= 720 ? 1 : 2,
    attributionControl: { compact: true },
    hash: "map",
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "bottom-right");

  // Bottom row: scale bar beside the collapsed attribution "i" (the bottom-left can be covered by the sidebar).
  const scale = new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" });
  map.addControl(scale, "bottom-right");
  const corner = map.getContainer().querySelector(".maplibregl-ctrl-bottom-right");
  corner.append(corner.querySelector(".maplibregl-ctrl-scale"));   // after the attribution → floats to its left

  // MapLibre opens compact attribution (and reopens it while the style loads) until the first drag;
  // keep it collapsed until the map is ready, after which only the "i" button toggles it.
  const attrib = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
  // only touch the class when needed: classList.remove always rewrites the attribute,
  // which would retrigger the observer forever
  const collapse = () => {
    if (attrib.classList.contains("maplibregl-compact-show")) attrib.classList.remove("maplibregl-compact-show");
  };
  const keepCollapsed = new MutationObserver(collapse);
  collapse();
  keepCollapsed.observe(attrib, { attributes: true, attributeFilter: ["class"] });
  map.once("idle", () => { collapse(); keepCollapsed.disconnect(); });
  map.touchZoomRotate.disableRotation();

  // ---------------------------------------------------------------- satellite basemap
  // Esri World Imagery (sub-meter in most places). It slots in under the boundaries and labels
  // of the vector style, so "Satellite" reads as a hybrid map; it stays hidden until switched on.
  const SATELLITE = "satellite";
  const CLUTTER = /^(building-3d|poi_|highway-|road_shield|airport)/;
  const addSatellite = () => {
    map.addSource(SATELLITE, {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics',
    });
    const layers = map.getStyle().layers;
    const before = layers.find((l) => l.id.startsWith("boundary")) || layers.find((l) => l.type === "symbol");
    map.addLayer({
      id: SATELLITE, type: "raster", source: SATELLITE,
      layout: { visibility: "none" },
      paint: { "raster-fade-duration": 150 },
    }, before && before.id);
  };

  class BasemapControl {
    onAdd() {
      this.el = document.createElement("div");
      this.el.className = "maplibregl-ctrl basemap-switch";
      this.el.setAttribute("role", "radiogroup");
      this.el.setAttribute("aria-label", "Base map");
      this.el.innerHTML = `
        <button type="button" role="radio" data-mode="map" aria-checked="true">Map</button>
        <button type="button" role="radio" data-mode="satellite" aria-checked="false">Satellite</button>`;
      this.el.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (btn) this.set(btn.dataset.mode);
      });
      return this.el;
    }
    set(mode) {
      if (!map.getLayer(SATELLITE)) return;   // style still loading
      const on = mode === "satellite";
      map.setLayoutProperty(SATELLITE, "visibility", on ? "visible" : "none");
      // 3D buildings would cover the imagery, and POI icons / road names just clutter it;
      // keep only boundaries and place/water labels on top
      for (const l of map.getStyle().layers) {
        if (CLUTTER.test(l.id)) map.setLayoutProperty(l.id, "visibility", on ? "none" : "visible");
      }
      map.getContainer().classList.toggle("is-satellite", on);
      this.el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    }
    onRemove() { this.el.remove(); }
  }
  map.addControl(new BasemapControl(), "top-right");

  // Phones: the search panel spans the top, so drop the switcher just below it.
  const panelEl = document.getElementById("panel");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--panel-bottom", `${panelEl.getBoundingClientRect().bottom}px`);
  }).observe(panelEl);

  // ---------------------------------------------------------------- data + layers
  map.on("load", async () => {
    addSatellite();
    const res = await fetch("api/sites.geojson");
    const data = await res.json();
    state.features = data.features.map((f) => ({ ...f, _search: normalize(`${f.properties.name} ${f.properties.countries}`) }));
    renderCounts();

    map.addSource("sites", { type: "geojson", data, promoteId: "id" });

    // MapLibre requires ["zoom"] interpolation at the top level, so per-feature
    // factors (hover) and offsets (danger ring) go inside each stop.
    const STOPS = [[1, 2.6], [3, 3.5], [6, 5.5], [10, 8], [14, 10]];
    const hover = ["case", ["boolean", ["feature-state", "hover"], false], 1.35, 1];
    const radius = (extra = 0) => ["interpolate", ["linear"], ["zoom"],
      ...STOPS.flatMap(([z, r]) => [z, ["+", ["*", r, hover], extra * (z < 6 ? 0.6 : 1)]])];
    const categoryColor = ["match", ["get", "category"],
      "Cultural", COLORS.Cultural, "Natural", COLORS.Natural, "Mixed", COLORS.Mixed, "#888"];

    // red halo for sites in danger (drawn under the dot)
    map.addLayer({
      id: "sites-danger",
      type: "circle",
      source: "sites",
      filter: ["==", ["get", "danger"], 1],
      paint: {
        "circle-radius": radius(3.5),
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": DANGER,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 1, 1.6, 8, 2.6],
      },
    });

    map.addLayer({
      id: "sites",
      type: "circle",
      source: "sites",
      layout: { "circle-sort-key": ["get", "danger"] },
      paint: {
        "circle-radius": radius(),
        "circle-color": categoryColor,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 1, 0.8, 8, 1.6],
        "circle-opacity": 0.95,
      },
    });

    map.addLayer({
      id: "sites-selected",
      type: "circle",
      source: "sites",
      filter: ["==", ["id"], -1],
      paint: {
        "circle-radius": radius(5),
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#1f2328",
        "circle-stroke-width": 2.5,
      },
    });

    // halo around the site hovered in the search results (unfiltered, so hidden categories still show)
    map.addLayer({
      id: "sites-preview",
      type: "circle",
      source: "sites",
      filter: ["==", ["id"], -1],
      paint: {
        "circle-radius": radius(9),
        "circle-color": categoryColor,
        "circle-opacity": 0.22,
        "circle-stroke-color": categoryColor,
        "circle-stroke-width": 2,
      },
    });

    applyFilters();
    map.on("moveend", renderVisibleCount);

    const fromUrl = new URLSearchParams(location.search).get("site");
    if (fromUrl) {
      const f = state.features.find((x) => String(x.id) === fromUrl);
      if (f) flyToSite(f, { instant: !location.hash });
      else {
        toast(`There is no World Heritage Site with reference number ${fromUrl}.`);
        const u = new URL(location.href);
        u.searchParams.delete("site");
        history.replaceState(null, "", u);
      }
    }
  });

  // ---------------------------------------------------------------- interaction
  map.on("mousemove", "sites", (e) => {
    const f = e.features[0];
    const id = f?.id;
    if (id === state.hoverId) return;
    setHover(id);
    map.getCanvas().style.cursor = "pointer";
    if (f) tooltip.setLngLat(f.geometry.coordinates.slice()).setText(f.properties.name).addTo(map);
  });
  map.on("mouseleave", "sites", () => {
    setHover(null);
    tooltip.remove();
    map.getCanvas().style.cursor = "";
  });
  map.on("click", "sites", (e) => {
    const f = e.features[0];
    tooltip.remove();
    openPopup(f.id, f.geometry.coordinates.slice());
  });
  // A click on empty map (not a drag) closes the details.
  map.on("click", (e) => {
    if (!state.popup || !map.getLayer("sites")) return;
    if (!map.queryRenderedFeatures(e.point, { layers: ["sites"] }).length) state.popup.remove();
  });

  function setHover(id) {
    if (state.hoverId != null) map.setFeatureState({ source: "sites", id: state.hoverId }, { hover: false });
    state.hoverId = id ?? null;
    if (id != null) map.setFeatureState({ source: "sites", id }, { hover: true });
  }

  // Mark a search result's dot on the map (null clears it, but only if a result set it).
  function previewSite(f) {
    const id = f?.id ?? null;
    if (id === state.previewId) return;
    if (id == null && state.previewId == null) return;
    state.previewId = id;
    setHover(id);
    if (map.getLayer("sites-preview")) map.setFilter("sites-preview", ["==", ["id"], id ?? -1]);
    if (f) tooltip.setLngLat(f.geometry.coordinates.slice()).setText(f.properties.name).addTo(map);
    else tooltip.remove();
  }

  // ---------------------------------------------------------------- filters
  document.querySelectorAll(".filters input").forEach((cb) =>
    cb.addEventListener("change", () => {
      cb.checked ? state.categories.add(cb.value) : state.categories.delete(cb.value);
      applyFilters();
    })
  );
  document.getElementById("danger-only").addEventListener("change", (e) => {
    state.dangerOnly = e.target.checked;
    applyFilters();
  });

  function filterExpr() {
    const parts = ["all", ["in", ["get", "category"], ["literal", [...state.categories]]]];
    if (state.dangerOnly) parts.push(["==", ["get", "danger"], 1]);
    return parts;
  }

  function applyFilters() {
    if (!map.getLayer("sites")) return;
    const f = filterExpr();
    map.setFilter("sites", f);
    map.setFilter("sites-danger", [...f, ["==", ["get", "danger"], 1]]);
    renderVisibleCount();
  }

  const isShown = (p) => state.categories.has(p.category) && (!state.dangerOnly || p.danger === 1);

  function renderCounts() {
    const n = { Cultural: 0, Natural: 0, Mixed: 0, danger: 0 };
    state.features.forEach(({ properties: p }) => { n[p.category]++; if (p.danger) n.danger++; });
    document.querySelectorAll("[data-n]").forEach((el) => (el.textContent = n[el.dataset.n].toLocaleString()));
  }

  function renderVisibleCount() {
    const shown = state.features.filter((f) => isShown(f.properties)).length;
    document.getElementById("count-visible").textContent = shown.toLocaleString();
  }

  // ---------------------------------------------------------------- search
  const input = document.getElementById("search");
  const list = document.getElementById("results");
  let results = [];
  let active = -1;

  input.addEventListener("input", () => runSearch(input.value));
  input.addEventListener("focus", () => input.value && runSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(active + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(active - 1, 0)); }
    else if (e.key === "Enter" && results.length) { e.preventDefault(); choose(results[Math.max(active, 0)]); }
    else if (e.key === "Escape") { closeResults(); input.blur(); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) closeResults(); });
  list.addEventListener("mouseleave", () => previewSite(null));

  function runSearch(q) {
    const terms = normalize(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return closeResults();
    const nq = terms.join(" ");
    results = state.features
      .filter((f) => terms.every((t) => f._search.includes(t)))
      .map((f) => {
        const name = normalize(f.properties.name);
        const score = name.startsWith(nq) ? 0 : name.includes(nq) ? 1 : 2;
        return { f, score };
      })
      .sort((a, b) => a.score - b.score || a.f.properties.name.localeCompare(b.f.properties.name))
      .slice(0, 30)
      .map((r) => r.f);

    previewSite(null);
    list.innerHTML = "";
    if (!results.length) {
      const li = el("li", "empty", "No matching sites");
      list.append(li);
    }
    results.forEach((f, i) => {
      const p = f.properties;
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = `r-${i}`;
      const dot = el("span", "dot");
      dot.style.background = COLORS[p.category];
      if (p.danger) dot.style.boxShadow = `0 0 0 2px ${DANGER}`;
      const name = el("span", "r-name");
      highlight(name, p.name, terms);
      li.append(dot, name, el("span", "r-meta", `${p.countries} · ${p.category}${p.year ? " · " + p.year : ""}`));
      li.addEventListener("mouseenter", () => previewSite(f));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(f); });
      list.append(li);
    });
    active = -1;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function setActive(i) {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute("aria-selected", j === i ? "true" : "false"));
    list.children[i]?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", `r-${i}`);
    previewSite(results[i]);
  }

  function closeResults() {
    previewSite(null);
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function choose(f) {
    closeResults();
    input.value = f.properties.name;
    // make sure the chosen site is visible under the current filters
    if (!isShown(f.properties)) {
      state.categories.add(f.properties.category);
      document.querySelector(`.filters input[value="${f.properties.category}"]`).checked = true;
      if (state.dangerOnly && !f.properties.danger) {
        state.dangerOnly = false;
        document.getElementById("danger-only").checked = false;
      }
      applyFilters();
    }
    flyToSite(f);
  }

  function flyToSite(f, { instant = false } = {}) {
    const coords = f.geometry.coordinates;
    const zoom = Math.max(map.getZoom(), 8);
    if (state.popup) state.popup.remove();
    // wide: centre in the map area right of the (soon full-height) sidebar;
    // phones keep the dot above the bottom sheet (adjusted once the sheet is open)
    const offset = narrow() ? [0, 0] : [document.getElementById("panel").offsetWidth / 2, 0];
    if (instant) {
      map.jumpTo({ center: coords, zoom, offset });
      openPopup(f.id, coords);
    } else {
      map.flyTo({ center: coords, zoom, offset, speed: 1.6, essential: true });
      map.once("moveend", () => openPopup(f.id, coords));
    }
  }

  // Wide: only pan if the selected dot is off-screen or behind the sidebar. Phones: keep it clear of the sheet.
  function ensureSiteVisible(details) {
    if (state.popup !== details || !state.coords) return;
    if (narrow()) return centerAboveSheet(details.getElement());
    const p = map.project(state.coords);
    const left = document.getElementById("panel").getBoundingClientRect().right;
    const { width, height } = map.getContainer().getBoundingClientRect();
    const pad = 40;
    if (p.x < left + pad || p.y < pad || p.x > width - pad || p.y > height - pad) {
      map.easeTo({ center: state.coords, offset: [left / 2, 0], duration: 400 });
    }
  }

  // Phones: move the selected dot into the free gap between the panel and the sheet.
  function centerAboveSheet(sheet) {
    const top = document.getElementById("panel").getBoundingClientRect().bottom;
    const bottom = sheet.getBoundingClientRect().top;
    const p = map.project(state.coords);
    const targetY = bottom > top + 40 ? (top + bottom) / 2 : bottom - 20;
    const dy = p.y - targetY, dx = p.x - window.innerWidth / 2;
    if (Math.abs(dy) > 8 || Math.abs(dx) > 40) map.panBy([dx, dy], { duration: 350 });
  }

  // ---------------------------------------------------------------- site details
  const NARROW = window.matchMedia("(max-width: 720px)");
  const narrow = () => NARROW.matches;

  // Site details live in the sidebar on wide screens and in a bottom sheet on phones.
  function openDetails(card) {
    const box = document.getElementById(narrow() ? "sheet" : "info");
    const body = box.querySelector("[data-body]");
    const handlers = [];
    body.innerHTML = "";
    box.scrollTop = body.scrollTop = 0;
    body.append(card);
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add("open"));
    const api = {
      getElement: () => box,
      on: (ev, fn) => { if (ev === "close") handlers.push(fn); return api; },
      remove: () => {
        if (box._owner !== api) return;
        box._owner = null;
        box.classList.remove("open");
        box.hidden = true;
        handlers.forEach((fn) => fn());
      },
    };
    box._owner = api;
    box.querySelector("[data-close]").onclick = () => api.remove();
    return api;
  }

  // Crossing the phone/desktop breakpoint: move open details to the other container.
  NARROW.addEventListener("change", () => {
    if (state.popup && state.selectedId != null) openPopup(state.selectedId, state.coords);
  });

  function selectOnMap(id) {
    if (map.getLayer("sites-selected")) map.setFilter("sites-selected", ["==", ["id"], id ?? -1]);
  }

  async function openPopup(id, coords) {
    if (state.popup) state.popup.remove();
    const card = el("article", "card");
    const popup = openDetails(card);
    state.popup = popup;
    state.coords = coords;
    state.selectedId = id;
    selectOnMap(id);
    popup.on("close", () => { if (state.popup === popup) { state.popup = null; state.selectedId = null; selectOnMap(null); } });

    const url = new URL(location.href);
    url.searchParams.set("site", id);
    history.replaceState(null, "", url);
    popup.on("close", () => {
      const u = new URL(location.href);
      u.searchParams.delete("site");
      history.replaceState(null, "", u);
    });

    const base = state.features.find((f) => f.id === id)?.properties;
    renderCard(card, base ? { ...base, loading: true } : { loading: true });

    try {
      const res = await fetch(`api/sites/${id}.json`);
      if (!res.ok) throw new Error(res.statusText);
      const site = await res.json();
      if (state.popup === popup) {
        renderCard(card, { ...site, coords }, () => ensureSiteVisible(popup));
        ensureSiteVisible(popup);
      }
    } catch {
      if (state.popup === popup) renderCard(card, { ...base, coords, description: "Details could not be loaded." });
    }
  }

  function renderCard(card, s, onImage) {
    card.innerHTML = "";

    const media = el("div", "card__media");
    if (s.image) {
      const img = new Image();
      img.alt = s.name || "";
      img.decoding = "async";
      img.onload = () => { img.classList.add("loaded"); onImage?.(); };
      img.onerror = () => media.remove();
      img.src = s.image;
      media.append(img);
      if (s.image_page) {
        const credit = el("a", "card__credit", s.image_page.includes("unesco.org") ? "Photo © UNESCO" : "Photo: Wikimedia Commons");
        credit.href = s.image_page;
        credit.target = "_blank";
        credit.rel = "noopener";
        media.append(credit);
      }
      card.append(media);
    } else if (s.loading) {
      card.append(media);
    }

    const body = el("div", "card__body");
    const badges = el("div", "card__badges");
    if (s.category) badges.append(el("span", `badge badge--${s.category}`, s.category));
    if (s.danger) badges.append(el("span", "badge badge--danger", "In danger"));
    body.append(badges);

    body.append(el("h2", null, s.name || ""));
    const meta = [s.countries, s.year && `Inscribed ${s.year}`].filter(Boolean).join(" · ");
    if (meta) body.append(el("p", "card__meta", meta));

    if (s.loading) body.append(el("div", "card__desc card__desc--loading"));
    else if (s.description) body.append(el("p", "card__desc", s.description));

    if (!s.loading) {
      const links = el("div", "card__links");
      if (s.unesco_url) links.append(link(s.unesco_url, "UNESCO", "", ICON_UNESCO));
      if (s.wikipedia_url) links.append(link(s.wikipedia_url, "Wikipedia", "", ICON_WIKI));
      if (s.coords) links.append(link(googleMapsUrl(s.coords), "Google Maps", "", ICON_PIN));
      body.append(links);
    }
    card.append(body);
  }

  // ---------------------------------------------------------------- keyboard
  // "f" toggles full screen (the whole page, so the panel stays usable); Esc exits as usual.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "f" && e.key !== "F") return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    const doc = document, root = doc.documentElement;
    const current = doc.fullscreenElement || doc.webkitFullscreenElement;
    const enter = root.requestFullscreen || root.webkitRequestFullscreen;
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (!enter) return;   // e.g. iPhone Safari
    e.preventDefault();
    const p = current ? exit.call(doc) : enter.call(root);
    if (p && p.catch) p.catch(() => {});
  });

  // ---------------------------------------------------------------- helpers
  function toast(message) {
    const t = el("div", "toast", message);
    t.setAttribute("role", "status");
    document.body.append(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4500);
  }

  const ICON_EXTERNAL = '<svg class="link__ext" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>';
  const ICON_UNESCO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 2 7v2h20V7L12 2Zm-7 9v7h2v-7H5Zm4 0v7h2v-7H9Zm4 0v7h2v-7h-2Zm4 0v7h2v-7h-2ZM2 20v2h20v-2H2Z"/></svg>';
  const ICON_WIKI = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 5h6v1.2l-1.6.3 3.9 9.2 2.1-4.8-2-4.4-1.4-.3V5h5.6v1.2l-1.4.3 1.2 2.9 1.4-2.9-1.5-.3V5h4.6v1.2l-1.6.4-2.4 5 2.6 5.6 3.8-9.1-1.7-.6V5H23v1.2l-1.3.4-5.6 12.9h-1l-3-6.6-3 6.6h-1L2.4 6.6 1 6.2V5Z"/></svg>';

  const ICON_PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7Zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/></svg>';

  // coords are [lng, lat] (GeoJSON order); Google wants "lat,lng"
  function googleMapsUrl([lng, lat]) {
    return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`;
  }

  function link(href, text, cls, icon) {
    const a = el("a", cls || null);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = icon;
    a.append(el("span", "link__text", text));
    a.insertAdjacentHTML("beforeend", ICON_EXTERNAL);
    a.title = `Opens ${new URL(href).hostname} in a new tab`;
    return a;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function normalize(s) {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  // Bold the matched terms without using innerHTML on data.
  function highlight(target, text, terms) {
    const norm = normalize(text);
    const marks = new Array(text.length).fill(false);
    terms.forEach((t) => {
      let i = norm.indexOf(t);
      while (i !== -1) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = norm.indexOf(t, i + t.length); }
    });
    let buf = "", on = false;
    const flush = () => { if (!buf) return; target.append(on ? el("mark", null, buf) : document.createTextNode(buf)); buf = ""; };
    [...text].forEach((ch, i) => { if (marks[i] !== on) { flush(); on = marks[i]; } buf += ch; });
    flush();
  }
})();

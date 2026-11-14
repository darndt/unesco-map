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
  };

  const map = new maplibregl.Map({
    container: "map",
    style: STYLE,
    center: [15, 30],
    zoom: window.innerWidth < 600 ? 1 : 2,
    attributionControl: { compact: true },
    hash: "map",
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "bottom-right");
  map.touchZoomRotate.disableRotation();

  // ---------------------------------------------------------------- data + layers
  map.on("load", async () => {
    const res = await fetch("/api/sites.geojson");
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
        "circle-color": ["match", ["get", "category"],
          "Cultural", COLORS.Cultural, "Natural", COLORS.Natural, "Mixed", COLORS.Mixed, "#888"],
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
    const id = e.features[0]?.id;
    if (id === state.hoverId) return;
    setHover(id);
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "sites", () => {
    setHover(null);
    map.getCanvas().style.cursor = "";
  });
  map.on("click", "sites", (e) => {
    const f = e.features[0];
    openPopup(f.id, f.geometry.coordinates.slice());
  });

  function setHover(id) {
    if (state.hoverId != null) map.setFeatureState({ source: "sites", id: state.hoverId }, { hover: false });
    state.hoverId = id ?? null;
    if (id != null) map.setFeatureState({ source: "sites", id }, { hover: true });
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
  }

  function closeResults() {
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
    // wide: leave room for the popup above the dot; narrow: keep the dot above the bottom sheet
    const offset = narrow() ? [0, 0] : [0, Math.min(200, window.innerHeight * 0.3)];
    if (state.popup) state.popup.remove();
    if (instant) {
      map.jumpTo({ center: coords, zoom, offset });
      openPopup(f.id, coords);
    } else {
      map.flyTo({ center: coords, zoom, offset, speed: 1.6, essential: true });
      map.once("moveend", () => openPopup(f.id, coords));
    }
  }

  // Pan just enough that the whole popup is on screen (and clear of the panel on wide screens).
  function ensurePopupVisible(popup) {
    const node = popup.getElement();
    if (!node || state.popup !== popup) return;
    if (narrow()) return centerAboveSheet(node);
    const r = node.getBoundingClientRect();
    const pad = 12;
    const panel = document.getElementById("panel").getBoundingClientRect();
    const wide = window.innerWidth > 900;
    const minLeft = wide ? panel.right + pad : pad;
    const minTop = wide ? pad : panel.bottom + pad;   // panel spans the top on narrow screens
    let dx = 0, dy = 0;
    if (r.top < minTop) dy = r.top - minTop;
    else if (r.bottom > window.innerHeight - pad) dy = r.bottom - window.innerHeight + pad;
    if (r.left < minLeft) dx = r.left - minLeft;
    else if (r.right > window.innerWidth - pad) dx = r.right - window.innerWidth + pad;
    if (dx || dy) map.panBy([dx, dy], { duration: 350 });
  }

  // Phones: move the selected dot into the free gap between the panel and the sheet.
  function centerAboveSheet(sheet) {
    if (!state.coords) return;
    const top = document.getElementById("panel").getBoundingClientRect().bottom;
    const bottom = sheet.getBoundingClientRect().top;
    const p = map.project(state.coords);
    const targetY = bottom > top + 40 ? (top + bottom) / 2 : bottom - 20;
    const dy = p.y - targetY, dx = p.x - window.innerWidth / 2;
    if (Math.abs(dy) > 8 || Math.abs(dx) > 40) map.panBy([dx, dy], { duration: 350 });
  }

  // ---------------------------------------------------------------- popup / sheet
  const narrow = () => window.matchMedia("(max-width: 600px)").matches;

  // Bottom sheet for phones, with the same small interface as a MapLibre popup.
  function createSheet(card) {
    const sheet = document.getElementById("sheet");
    const body = sheet.querySelector(".sheet__body");
    const handlers = [];
    body.innerHTML = "";
    body.scrollTop = 0;
    body.append(card);
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add("open"));
    const api = {
      getElement: () => sheet,
      on: (ev, fn) => { if (ev === "close") handlers.push(fn); return api; },
      remove: () => {
        if (sheet._owner !== api) return;
        sheet._owner = null;
        sheet.classList.remove("open");
        sheet.hidden = true;
        handlers.forEach((fn) => fn());
      },
    };
    sheet._owner = api;
    sheet.querySelector(".sheet__close").onclick = () => api.remove();
    return api;
  }

  function selectOnMap(id) {
    if (map.getLayer("sites-selected")) map.setFilter("sites-selected", ["==", ["id"], id ?? -1]);
  }

  async function openPopup(id, coords) {
    if (state.popup) state.popup.remove();
    const card = el("article", "card");
    const popup = narrow()
      ? createSheet(card)
      : new maplibregl.Popup({ className: "site-popup", maxWidth: "340px", offset: 14, focusAfterOpen: false })
          .setLngLat(coords).setDOMContent(card).addTo(map);
    state.popup = popup;
    state.coords = coords;
    selectOnMap(id);
    popup.on("close", () => { if (state.popup === popup) { state.popup = null; selectOnMap(null); } });

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
      const res = await fetch(`/api/sites/${id}`);
      if (!res.ok) throw new Error(res.statusText);
      const site = await res.json();
      if (state.popup === popup) {
        renderCard(card, site, () => ensurePopupVisible(popup));
        ensurePopupVisible(popup);
      }
    } catch {
      if (state.popup === popup) renderCard(card, { ...base, description: "Details could not be loaded." });
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
      body.append(links);
    }
    card.append(body);
  }

  // ---------------------------------------------------------------- helpers
  function toast(message) {
    const t = el("div", "toast", message);
    t.setAttribute("role", "status");
    document.body.append(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4500);
  }

  const ICON_UNESCO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 2 7v2h20V7L12 2Zm-7 9v7h2v-7H5Zm4 0v7h2v-7H9Zm4 0v7h2v-7h-2Zm4 0v7h2v-7h-2ZM2 20v2h20v-2H2Z"/></svg>';
  const ICON_WIKI = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 5h6v1.2l-1.6.3 3.9 9.2 2.1-4.8-2-4.4-1.4-.3V5h5.6v1.2l-1.4.3 1.2 2.9 1.4-2.9-1.5-.3V5h4.6v1.2l-1.6.4-2.4 5 2.6 5.6 3.8-9.1-1.7-.6V5H23v1.2l-1.3.4-5.6 12.9h-1l-3-6.6-3 6.6h-1L2.4 6.6 1 6.2V5Z"/></svg>';

  function link(href, text, cls, icon) {
    const a = el("a", cls || null);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = icon;
    a.append(document.createTextNode(text));
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

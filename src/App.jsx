import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Plus, Trash2, Check, X, Minus, RotateCcw, Target,
  ClipboardList, BarChart3, Flag, Loader2, ArrowRightLeft
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import { extractPdfText } from "./lib/pdfExtract.js";
import { fetchClubElo, computeEloMatchup } from "./lib/clubElo.js";

/* ---------------------------------------------------------------
   THEME
--------------------------------------------------------------- */
const C = {
  bg: "#0A0D12",
  surface: "#12161F",
  surface2: "#1A2029",
  line: "#252C38",
  text: "#EDEFF3",
  dim: "#8891A3",
  faint: "#5B6479",
  teamA: "#FF9142",
  teamB: "#4FA8FF",
  solide: "#35D0A6",
  jouable: "#F2B84B",
  fragile: "#FF5C6C",
};
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'Inter', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

/* ---------------------------------------------------------------
   MATH HELPERS
--------------------------------------------------------------- */
function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}
function poissonCdf(k, lambda) {
  let s = 0;
  for (let i = 0; i <= k; i++) s += poissonPmf(i, lambda);
  return s;
}
function estimateProb(line, moyenne, sens) {
  const k = Math.floor(line);
  const cdf = poissonCdf(k, Math.max(moyenne, 0.01));
  return sens === "Over" ? 1 - cdf : cdf;
}
function computeVerdict({ moyenne, ligne, volatilite, fallbackVol }) {
  const margeRaw = moyenne - ligne;
  const sens = margeRaw >= 0 ? "Over" : "Under";
  const marge = Math.abs(margeRaw);
  let vol, volSource;
  if (volatilite && volatilite > 0) {
    vol = volatilite;
    volSource = "manuelle";
  } else if (fallbackVol && fallbackVol > 0) {
    vol = fallbackVol;
    volSource = "historique";
  } else {
    vol = Math.sqrt(Math.max(moyenne, 0.1));
    volSource = "estimée";
  }
  const ratio = marge / vol;
  let verdict = "Fragile";
  if (ratio >= 1) verdict = "Solide";
  else if (ratio >= 0.5) verdict = "Jouable";
  return { sens, marge, vol, ratio, verdict, volSource };
}
function impliedProb(cote) {
  const c = parseFloat(cote);
  if (!c || c <= 1) return null;
  return 1 / c;
}

/* Suggestion de handicap — portage direct de la logique de "Corner Predictor 1MT"
   (app Streamlit) : volume total projeté comparé à un seuil ; si le volume est haut ET
   la volatilité reste basse, le signal est jugé assez fiable pour un handicap plus engagé.
   Seuils par défaut identiques à l'outil d'origine (calibrés sur des totaux 1ère MT —
   à ajuster si on l'applique à un autre marché).
   Fonction de base : prend directement un volume projeté + une volatilité (déjà
   calculés, qu'ils viennent d'UNE équipe ou d'un DUEL croisé entre deux équipes). */
function volumeSignalFromValues(totalProjete, vol, seuilVolume = 6.0, seuilVolatilite = 1.4) {
  if (totalProjete === null || totalProjete === undefined || vol === null || vol === undefined) return null;
  const fort = totalProjete >= seuilVolume && vol <= seuilVolatilite;
  return { totalProjete, vol, fort, seuilVolume, seuilVolatilite };
}
/* Variante "solo" : volume projeté = EWMA(obtenus) + EWMA(concédés) d'UNE seule équipe,
   sur son propre historique (tous adversaires confondus) — utile dans le profil d'équipe
   avant même d'avoir choisi l'adversaire du duel. */
function computeVolumeSignal(series, seuilVolume = 6.0, seuilVolatilite = 1.4) {
  if (!series || series.ewmaObtenus === null || series.ewmaConcedes === null) return null;
  return volumeSignalFromValues(series.ewmaObtenus + series.ewmaConcedes, series.volatilite, seuilVolume, seuilVolatilite);
}
/* Badge de "forme" — pensé pour les buts (mais réutilisable ailleurs) : contrairement au
   signal volume des corners ci-dessus (seuil absolu, ex. ≥6.0), celui-ci utilise le RATIO
   EWMA/volatilité, comme le verdict Solide/Jouable/Fragile déjà utilisé dans le
   Comparateur. Une équipe irrégulière (grosse volatilité) a besoin d'un EWMA plus extrême
   pour être jugée "en forme" qu'une équipe régulière — logique vu qu'un seul match à gros
   score peut à lui seul faire bouger l'EWMA de +1, sans que ce soit une vraie tendance. */
function computeFormLabel(series) {
  if (!series || series.ewma === null || series.ewma === undefined) return null;
  const vol = series.volatilite && series.volatilite > 0 ? series.volatilite : Math.sqrt(Math.max(Math.abs(series.ewma), 0.1));
  const ratio = Math.abs(series.ewma) / vol;
  let label, color;
  if (ratio < 0.5) {
    label = "Neutre";
    color = C.faint;
  } else if (series.ewma > 0) {
    label = ratio >= 1 ? "Bonne forme" : "En forme";
    color = ratio >= 1 ? C.solide : C.jouable;
  } else {
    label = ratio >= 1 ? "En perdition" : "Difficultés";
    color = ratio >= 1 ? C.fragile : C.jouable;
  }
  return { label, ratio, color };
}
/* Synthèse "quelle équipe + quelle mi-temps" pour un handicap corners — combine :
   - la projection croisée déjà utilisée ailleurs (projA vs projB) pour désigner
     l'équipe favorite et évaluer la confiance (marge / volatilité, via computeVerdict,
     réutilisé tel quel : ici "moyenne" = projA, "ligne" = projB, donc "Over" = A
     favori) ;
   - le signal de volume total (fort / sécurisé) déjà utilisé dans les panneaux.
   Retourne null si l'une des deux séries manque. */
function evaluateMiTempsHandicap(seriesA, seriesB) {
  if (!seriesA || !seriesB) return null;
  const proj = projection(seriesA.moyObtenus, seriesB.moyConcedes, seriesB.moyObtenus, seriesA.moyConcedes);
  const volCombined = seriesA.volatilite || seriesB.volatilite ? Math.sqrt(seriesA.volatilite ** 2 + seriesB.volatilite ** 2) : null;
  const { sens, marge, ratio, verdict } = computeVerdict({ moyenne: proj.projA, ligne: proj.projB, volatilite: volCombined });
  const favori = sens === "Over" ? "A" : "B";
  const volumeSignal = volumeSignalFromValues(proj.total, volCombined);
  return { proj, volCombined, marge, ratio, verdict, favori, volumeSignal, n: Math.min(seriesA.n, seriesB.n) };
}
const verdictColor = (v) => (v === "Solide" ? C.solide : v === "Jouable" ? C.jouable : C.fragile);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

/* projection croisée : ce que chaque équipe devrait produire dans CE duel,
   moyenne de son propre volume offensif et du volume concédé par l'adversaire */
function projection(teamAObtenus, teamBConcedes, teamBObtenus, teamAConcedes) {
  const projA = (teamAObtenus + teamBConcedes) / 2;
  const projB = (teamBObtenus + teamAConcedes) / 2;
  return { projA, projB, total: projA + projB };
}

/* ---------------------------------------------------------------
   ARC GAUGE — signature visual
--------------------------------------------------------------- */
function ArcGauge({ ratio, verdict, size = 56 }) {
  const clamped = Math.max(0, Math.min(ratio, 1));
  const angle = clamped * 90;
  const color = verdictColor(verdict);
  const r = size * 0.42;
  const cx = 6;
  const cy = size - 6;
  const toXY = (deg) => {
    const a = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };
  const top = toXY(-90);
  const sweepEnd = toXY(-90 + angle);
  const flat = toXY(0);
  const bgPath = `M ${cx} ${cy} L ${top.x} ${top.y} A ${r} ${r} 0 0 1 ${flat.x} ${flat.y} Z`;
  const fillPath = `M ${cx} ${cy} L ${top.x} ${top.y} A ${r} ${r} 0 0 1 ${sweepEnd.x} ${sweepEnd.y} Z`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <path d={bgPath} fill={C.surface2} />
      <path d={fillPath} fill={color} opacity={0.9} />
      <path d={`M ${cx} ${cy - r} L ${cx} ${cy} L ${cx + r} ${cy}`} stroke={C.line} strokeWidth="1.5" fill="none" />
      <circle cx={cx} cy={cy} r="2" fill={C.dim} />
    </svg>
  );
}

/* ---------------------------------------------------------------
   SMALL UI PRIMITIVES
--------------------------------------------------------------- */
function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1" style={{ fontFamily: FONT_BODY }}>
      <span style={{ fontSize: 10.5, color: C.dim, letterSpacing: 0.4, textTransform: "uppercase" }}>{label}</span>
      {children}
    </label>
  );
}
const inputStyle = {
  background: C.surface2,
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  padding: "8px 10px",
  color: C.text,
  fontFamily: FONT_MONO,
  fontSize: 14,
  outline: "none",
  width: "100%",
};
function NumInput({ value, onChange, placeholder, accent }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, borderColor: accent ? accent + "55" : C.line }}
    />
  );
}
function TextInput({ value, onChange, placeholder, accent }) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, fontFamily: FONT_BODY, borderColor: accent ? accent + "55" : C.line }}
    />
  );
}
function Pill({ children, color }) {
  return (
    <span
      style={{
        background: `${color}22`,
        color,
        border: `1px solid ${color}55`,
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        fontFamily: FONT_BODY,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
function IconBtn({ onClick, children, color = C.dim, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: "transparent",
        border: `1px solid ${C.line}`,
        borderRadius: 8,
        padding: 6,
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
function SplitBar({ left, right, colorLeft, colorRight, labelLeft, labelRight }) {
  const total = left + right || 1;
  const pctLeft = (left / total) * 100;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: FONT_MONO, marginBottom: 4 }}>
        <span style={{ color: colorLeft, fontWeight: 700 }}>{labelLeft}</span>
        <span style={{ color: colorRight, fontWeight: 700 }}>{labelRight}</span>
      </div>
      <div style={{ display: "flex", height: 6, borderRadius: 4, overflow: "hidden", background: C.surface2 }}>
        <div style={{ width: `${pctLeft}%`, background: colorLeft }} />
        <div style={{ width: `${100 - pctLeft}%`, background: colorRight }} />
      </div>
    </div>
  );
}
function addRowStyle() {
  return {
    marginTop: 10,
    width: "100%",
    background: "transparent",
    border: `1px dashed ${C.line}`,
    borderRadius: 10,
    padding: "10px",
    color: C.dim,
    fontSize: 13,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    cursor: "pointer",
  };
}
function SectionTitle({ children, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
      <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 700, margin: 0, letterSpacing: 0.3 }}>{children}</h2>
      {sub && <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: C.faint }}>{sub}</span>}
    </div>
  );
}
function EmptyState({ title, text }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 20px", color: C.dim, border: `1px dashed ${C.line}`, borderRadius: 14 }}>
      <Flag size={26} color={C.faint} style={{ marginBottom: 10 }} />
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, color: C.text, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, maxWidth: 260, margin: "0 auto" }}>{text}</div>
    </div>
  );
}

/* ---------------------------------------------------------------
   TEAM PROFILE CARD — obtenus/concédés, part des corners, EWMA diff
--------------------------------------------------------------- */
/* calcule part réelle + EWMA réelle à partir d'un historique de matchs
   (du plus ancien au plus récent), alpha = poids donné au match le plus récent */
/* Calcul générique (obtenus/concédés -> n, moyennes, part, EWMA, volatilité, totaux
   par match) — réutilisé pour les corners, les tirs, et les attaques dangereuses,
   pour ne pas dupliquer la même logique trois fois. */
function computeStatSeries(matches, obtKey, concKey, alpha = 0.25) {
  const valid = matches.filter((m) => m[obtKey] !== "" && m[obtKey] !== undefined && m[concKey] !== "" && m[concKey] !== undefined);
  if (!valid.length) return null;
  const chronological = [...valid].reverse();
  let sumObt = 0;
  let sumConc = 0;
  let ewma = null;
  let ewmaObtenus = null;
  let ewmaConcedes = null;
  const totals = [];
  chronological.forEach((m) => {
    const o = num(m[obtKey]);
    const c = num(m[concKey]);
    sumObt += o;
    sumConc += c;
    totals.push(o + c);
    const diff = o - c;
    ewma = ewma === null ? diff : alpha * diff + (1 - alpha) * ewma;
    ewmaObtenus = ewmaObtenus === null ? o : alpha * o + (1 - alpha) * ewmaObtenus;
    ewmaConcedes = ewmaConcedes === null ? c : alpha * c + (1 - alpha) * ewmaConcedes;
  });
  const n = chronological.length;
  const meanTotal = totals.reduce((s, t) => s + t, 0) / n;
  const variance = totals.reduce((s, t) => s + (t - meanTotal) ** 2, 0) / n;
  return {
    n,
    moyObtenus: sumObt / n,
    moyConcedes: sumConc / n,
    part: (sumObt / (sumObt + sumConc || 1)) * 100,
    ewma,
    ewmaObtenus,
    ewmaConcedes,
    volatilite: Math.sqrt(variance),
    totals,
  };
}

/* Victoire/Nul/Défaite sur le "duel des corners" d'un match (obtenus vs concédés) —
   même logique que le tableau Vic/Nul/Déf de TotalCorner, réutilisable pour le total
   du match comme pour chaque mi-temps séparément. */
function computeVND(matches, obtKey, concKey) {
  const valid = matches.filter((m) => m[obtKey] !== "" && m[obtKey] !== undefined && m[concKey] !== "" && m[concKey] !== undefined);
  const n = valid.length;
  if (!n) return null;
  let vic = 0;
  let nul = 0;
  let def = 0;
  valid.forEach((m) => {
    const o = num(m[obtKey]);
    const c = num(m[concKey]);
    if (o > c) vic++;
    else if (o === c) nul++;
    else def++;
  });
  return { n, vic, nul, def, pctVic: (vic / n) * 100 };
}

/* Corrélation (Pearson r) + régression linéaire simple entre le total corners d'un
   match et le total d'une autre statistique (tirs ou attaques dangereuses), calculée
   sur l'historique propre d'UNE équipe (ses corners et sa stat dans SES matchs).
   Sert de base honnête à l'estimation "Prédiction" — r et n sont toujours affichés,
   jamais cachés derrière un score composite. */
function computeCorrelation(matches, obtKey, concKey) {
  const valid = matches.filter((m) => m.obtenus !== "" && m.concedes !== "" && m[obtKey] !== "" && m[obtKey] !== undefined && m[concKey] !== "" && m[concKey] !== undefined);
  const n = valid.length;
  if (n < 4) return { r: 0, slope: 0, intercept: 0, n };
  const cornersTotals = valid.map((m) => num(m.obtenus) + num(m.concedes));
  const statTotals = valid.map((m) => num(m[obtKey]) + num(m[concKey]));
  const meanC = cornersTotals.reduce((s, t) => s + t, 0) / n;
  const meanS = statTotals.reduce((s, t) => s + t, 0) / n;
  let cov = 0;
  let denC = 0;
  let denS = 0;
  for (let i = 0; i < n; i++) {
    const dc = cornersTotals[i] - meanC;
    const ds = statTotals[i] - meanS;
    cov += dc * ds;
    denC += dc * dc;
    denS += ds * ds;
  }
  const r = denC > 0 && denS > 0 ? cov / Math.sqrt(denC * denS) : 0;
  const slope = denS > 0 ? cov / denS : 0;
  const intercept = meanC - slope * meanS;
  return { r, slope, intercept, n };
}

function computeHistoryStats(matches, alpha = 0.25, includeAdvanced = true) {
  const corners = computeStatSeries(matches, "obtenus", "concedes", alpha);
  if (!corners) return null;
  const vndTotal = computeVND(matches, "obtenus", "concedes");

  if (!includeAdvanced) {
    return { ...corners, vndTotal, tirs: null, attDang: null, tirsSeries: null, attDangSeries: null, corrTirs: null, corrAttDang: null, mt1Series: null, mt2Series: null, vndMT1: null, vndMT2: null };
  }

  // tirs — entièrement optionnel : ratio de conversion Total/Obtenu/Concédé (affiché
  // dans le profil), la série complète (pour la projection croisée), et la corrélation
  // avec les corners (pour l'estimation "Prédiction").
  const withShots = matches.filter((m) => m.obtenus !== "" && m.concedes !== "" && m.tirsObtenus !== "" && m.tirsObtenus !== undefined && m.tirsConcedes !== "" && m.tirsConcedes !== undefined);
  let tirs = null;
  if (withShots.length >= 3) {
    const sumTirsObt = withShots.reduce((s, m) => s + num(m.tirsObtenus), 0);
    const sumTirsConc = withShots.reduce((s, m) => s + num(m.tirsConcedes), 0);
    const sumCornersObtOnThose = withShots.reduce((s, m) => s + num(m.obtenus), 0);
    const sumCornersConcOnThose = withShots.reduce((s, m) => s + num(m.concedes), 0);
    tirs = {
      n: withShots.length,
      moyTirsObtenus: sumTirsObt / withShots.length,
      moyTirsConcedes: sumTirsConc / withShots.length,
      ratioObtenu: sumTirsObt > 0 ? sumCornersObtOnThose / sumTirsObt : null,
      ratioConcede: sumTirsConc > 0 ? sumCornersConcOnThose / sumTirsConc : null,
      ratioTotal: sumTirsObt + sumTirsConc > 0 ? (sumCornersObtOnThose + sumCornersConcOnThose) / (sumTirsObt + sumTirsConc) : null,
    };
  }

  const withAttDang = matches.filter((m) => m.obtenus !== "" && m.concedes !== "" && m.attDangObtenus !== "" && m.attDangObtenus !== undefined && m.attDangConcedes !== "" && m.attDangConcedes !== undefined);
  let attDang = null;
  if (withAttDang.length >= 3) {
    const sumAttObt = withAttDang.reduce((s, m) => s + num(m.attDangObtenus), 0);
    const sumAttConc = withAttDang.reduce((s, m) => s + num(m.attDangConcedes), 0);
    const sumCornersObtOnThose = withAttDang.reduce((s, m) => s + num(m.obtenus), 0);
    const sumCornersConcOnThose = withAttDang.reduce((s, m) => s + num(m.concedes), 0);
    attDang = {
      n: withAttDang.length,
      moyAttObtenus: sumAttObt / withAttDang.length,
      moyAttConcedes: sumAttConc / withAttDang.length,
      ratioObtenu: sumAttObt > 0 ? sumCornersObtOnThose / sumAttObt : null,
      ratioConcede: sumAttConc > 0 ? sumCornersConcOnThose / sumAttConc : null,
      ratioTotal: sumAttObt + sumAttConc > 0 ? (sumCornersObtOnThose + sumCornersConcOnThose) / (sumAttObt + sumAttConc) : null,
    };
  }

  const tirsSeries = computeStatSeries(matches, "tirsObtenus", "tirsConcedes", alpha);
  const attDangSeries = computeStatSeries(matches, "attDangObtenus", "attDangConcedes", alpha);
  const corrTirs = computeCorrelation(matches, "tirsObtenus", "tirsConcedes");
  const corrAttDang = computeCorrelation(matches, "attDangObtenus", "attDangConcedes");

  // corners par mi-temps — même principe que les corners totaux (moyenne, part,
  // EWMA, volatilité déjà couverts par computeStatSeries) + Vic/Nul/Déf par mi-temps
  const mt1Series = computeStatSeries(matches, "corners1MTObtenus", "corners1MTConcedes", alpha);
  const mt2Series = computeStatSeries(matches, "corners2MTObtenus", "corners2MTConcedes", alpha);
  const vndMT1 = computeVND(matches, "corners1MTObtenus", "corners1MTConcedes");
  const vndMT2 = computeVND(matches, "corners2MTObtenus", "corners2MTConcedes");

  // buts (match complet) — extraits automatiquement du score lors du collage Xodo,
  // même logique EWMA/volatilité/projection que les corners
  const butsSeries = computeStatSeries(matches, "butsObtenus", "butsConcedes", alpha);
  const vndButs = computeVND(matches, "butsObtenus", "butsConcedes");

  return {
    ...corners,
    vndTotal,
    tirs,
    attDang,
    tirsSeries,
    attDangSeries,
    corrTirs,
    corrAttDang,
    mt1Series,
    mt2Series,
    vndMT1,
    vndMT2,
    butsSeries,
    vndButs,
  };
}

const emptyTeam = () => ({ nom: "", obtenus: "", concedes: "", part: "", ewma: "", mode: "moyennes", matches: [], useAdvanced: false, excludedLigues: [] });

/* choisit les stats les plus pertinentes pour CE match : d'abord le sous-ensemble
   domicile/extérieur si assez de matchs tagués (>= minN), sinon tout l'historique,
   sinon les moyennes saisies à la main */
function pickVenueStats(team, venue, minN = 3) {
  const overall = computeHistoryStats(team.matches, 0.25, !!team.useAdvanced);
  const venueMatches = team.matches.filter((m) => m.lieu === venue);
  const venueStats = venueMatches.length ? computeHistoryStats(venueMatches, 0.25, !!team.useAdvanced) : null;
  if (venueStats && venueStats.n >= minN) {
    return {
      nom: team.nom,
      obtenus: venueStats.moyObtenus,
      concedes: venueStats.moyConcedes,
      part: venueStats.part,
      ewma: venueStats.ewma,
      volatilite: venueStats.volatilite,
      source: venue === "D" ? "domicile" : "extérieur",
      n: venueStats.n,
      tirsSeries: venueStats.tirsSeries,
      attDangSeries: venueStats.attDangSeries,
      mt1Series: venueStats.mt1Series,
      mt2Series: venueStats.mt2Series,
      vndTotal: venueStats.vndTotal,
      vndMT1: venueStats.vndMT1,
      vndMT2: venueStats.vndMT2,
      butsSeries: venueStats.butsSeries,
      vndButs: venueStats.vndButs,
    };
  }
  if (overall) {
    return {
      nom: team.nom,
      obtenus: overall.moyObtenus,
      concedes: overall.moyConcedes,
      part: overall.part,
      ewma: overall.ewma,
      volatilite: overall.volatilite,
      source: "tous matchs",
      n: overall.n,
      tirsSeries: overall.tirsSeries,
      attDangSeries: overall.attDangSeries,
      mt1Series: overall.mt1Series,
      mt2Series: overall.mt2Series,
      vndTotal: overall.vndTotal,
      vndMT1: overall.vndMT1,
      vndMT2: overall.vndMT2,
      butsSeries: overall.butsSeries,
      vndButs: overall.vndButs,
    };
  }
  return { nom: team.nom, obtenus: num(team.obtenus), concedes: num(team.concedes), part: team.part, ewma: team.ewma, volatilite: null, source: "manuel", n: 0, tirsSeries: null, attDangSeries: null, mt1Series: null, mt2Series: null, vndTotal: null, vndMT1: null, vndMT2: null, butsSeries: null, vndButs: null };
}

/* Variante pour les confrontations directes : on connaît les 2 équipes précises,
   donc on assigne obtenusA/obtenusB au bon côté peu importe qui jouait à domicile
   ce jour-là (contrairement au domicile/extérieur fixe des profils saison). */
function parseRawH2hBlock(text, teamAName, teamBName) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const stripRank = (s) => s.replace(/^\(\d+\)\s*/, "").trim().toLowerCase();
  const targetA = stripRank(teamAName || "");
  const targetB = stripRank(teamBName || "");
  const dateRe = /^\d{2}\/\d{4}$/;
  const numRe = /^-?\d+(\.\d+)?$/;
  const results = [];
  const skipped = [];

  let i = 0;
  while (i < lines.length) {
    if (dateRe.test(lines[i])) {
      const team1 = lines[i + 1];
      const team2 = lines[i + 2];
      let j = i + 3;
      // ignore les lignes texte parasites (ex : "Inclus dans stats TàT") entre les
      // noms d'équipe et le début des chiffres, sans dépasser le prochain bloc date
      while (j < lines.length && !numRe.test(lines[j]) && !dateRe.test(lines[j])) j++;
      const nums = [];
      while (j < lines.length && numRe.test(lines[j])) {
        nums.push(Number(lines[j]));
        j++;
      }
      if (team1 && team2 && nums.length >= 4 && nums.length % 2 === 0) {
        const cornersHome = nums[nums.length - 2];
        const cornersAway = nums[nums.length - 1];
        const t1 = stripRank(team1);
        const t2 = stripRank(team2);
        if (targetA && targetB && t1.includes(targetA) && t2.includes(targetB)) {
          results.push({ id: uid(), obtenusA: String(cornersHome), obtenusB: String(cornersAway) });
        } else if (targetA && targetB && t1.includes(targetB) && t2.includes(targetA)) {
          results.push({ id: uid(), obtenusA: String(cornersAway), obtenusB: String(cornersHome) });
        } else {
          skipped.push(`${team1} vs ${team2}`);
        }
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return { results, skipped };
}

/* Extraction spécifique au format TotalCorner (repéré dans le fichier que tu as
   partagé) : le texte copié contient des marqueurs de lien "(/fr/league/view/ID)" et
   "(/fr/team/view/ID)" autour des noms d'équipe, "Temps plein" pour un match terminé,
   puis les colonnes corners et attaques dangereuses sous forme "X - Y". On extrait les
   deux d'un coup, et on tague D/E selon si l'équipe recherchée jouait à domicile.
   ⚠️ Ne fonctionne que si le copier-coller du site conserve ces marqueurs — sur mobile
   ça peut ne pas être le cas (d'où le recours à Google Lens que tu as dû faire).

   MI-TEMPS — deux formats possibles selon l'outil de copier-coller utilisé :
   1) Format Xodo (fiable) : la mi-temps "(A-B)" est TOUJOURS collée juste après le
      score total de la colonne Corner, ex. "7 - 6 (2-3)" — parfois avec le handicap
      intercalé entre les deux ("1 - 2 -0.5 (1-0)"). On la lit directement ligne par
      ligne, donc AUCUNE ambiguïté d'association possible, page 1 ou page suivante,
      sélection complète ou partielle.
   2) Ancien format (bug du copier-coller standard, avant Xodo) : les mi-temps
      atterrissent regroupées en bulles détachées ailleurs dans le texte, une zone par
      page — conservé ici uniquement en repli, si jamais aucune mi-temps inline n'est
      trouvée pour un match donné. */
function parseTotalCornerBlock(raw, teamName) {
  const target = (teamName || "").trim().toLowerCase();
  // mots significatifs du nom (>=3 caractères) — si le site abrège/complète le nom
  // différemment de ce que tu as tapé, on accepte une correspondance sur un seul mot
  // clé plutôt que d'exiger le nom entier en substring exacte
  const targetWords = target.split(/\s+/).filter((w) => w.length >= 3);

  // Corner total "X - Y" suivi (avec parfois le handicap intercalé, ex. "-0.5") de la
  // mi-temps "(A-B)" — c'est le format Xodo, fiable, ligne par ligne.
  const inlineCornerHalfRe =
    /(\d+)\s{0,10}-\s{0,10}(\d+)(?:\s{1,10}[+-]?\d+(?:\.\d+)?)?\s{0,10}\(\s{0,10}(\d+)\s{0,10}-\s{0,10}(\d+)\s{0,10}\)/;

  // Repli ancien format : bulles "(X-Y)" regroupées en zones (>= 4 bulles consécutives),
  // une zone par page, associée aux matchs qui la suivent immédiatement.
  const bubbleZoneRe = /(?:\(\d+-\d+\)\s*){4,}/g;
  const zones = [...raw.matchAll(bubbleZoneRe)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    bubbles: [...m[0].matchAll(/\((\d+)-(\d+)\)/g)].map((b) => [parseInt(b[1], 10), parseInt(b[2], 10)]),
  }));

  const blockSplitRe = /\(\/fr\/league\/view\/\d+\)/g;
  const blockMatches = [...raw.matchAll(blockSplitRe)];
  const blockStarts = blockMatches.map((m) => m.index + m[0].length);
  const blockMarkerStarts = blockMatches.map((m) => m.index);
  const blocks = raw.split(/\(\/fr\/league\/view\/\d+\)/).slice(1);
  const results = [];
  const skipped = [];

  // Détection automatique du nom de la ligue/compétition, qui apparaît toujours juste
  // avant le marqueur "(/fr/league/view/ID)" — parfois collé sans espace à la fin d'un
  // lien précédent (ex. "...elfsborg-vsSweden Allsvenskan"), d'où la détection par la
  // MAJUSCULE/idéogramme de départ plutôt que par un simple découpage sur les espaces.
  // Le nom BRUT est conservé (pas juste une classification L/C/A) pour permettre un
  // filtre à cocher dynamique, comme celui de TotalCorner lui-même.
  // fragments connus de l'en-tête du tableau (répété en haut de chaque page), à retirer
  // AVANT toute analyse — bien plus robuste qu'un nettoyage mot par mot après coup, qui
  // peine à suivre quand l'en-tête se recompose différemment selon les sauts de ligne
  const HEADER_NOISE_RE =
    /Ligue\s*Heure\s*Domicile\s*Score\s*Extérieur\s*Handicap\s*Corner|Ligne\s*de\s*corners|Corner\s*O\/U|Total\s*buts|Buts\s*O\/U|Attaque\s*dangereuse|Événements\s*en\s*direct|Analyse|\bO\/U\b/gi;

  const detectLeagueName = (markerStart) => {
    const windowSize = 400;
    const cut = Math.max(0, markerStart - windowSize);
    const before = raw.slice(cut, markerStart).replace(HEADER_NOISE_RE, " ");
    let lines = before.split("\n").map((s) => s.trim()).filter(Boolean);
    // si on a effectivement tronqué (cut > 0), la toute première ligne peut être coupée
    // en plein mot — une lettre isolée en début de ligne suffit à passer pour un faux
    // début de nom valide, donc on l'écarte par sécurité ; sans troncature réelle (tout
    // début de document), on la garde
    if (cut > 0 && lines.length > 1) lines = lines.slice(1);
    // on regroupe les 3 dernières lignes (le nom peut être coupé sur plusieurs lignes
    // en extraction PDF) puis on ne garde que le suffixe qui ressemble à un nom —
    // lettres/chiffres/espaces/tirets uniquement (les chiffres sont nécessaires pour
    // des noms comme "Premier League 1"), ce qui élimine naturellement tout fragment
    // d'URL collé devant (ex. ".../ca-san-miguelArgentina Nacional B")
    const joined = lines.slice(-3).join(" ");
    const nm = joined.match(/([A-ZÀ-ÖØ-Þ\p{Script=Han}][\p{L}\d\s\-'\u2019.]*)$/u);
    if (!nm) return "";
    let name = nm[1].trim();
    // filet de sécurité : mots-outils isolés (liens) qui peuvent encore se retrouver
    // devant le vrai nom une fois les lignes regroupées
    const NOISE_PREFIXES = ["Cotes", "Stats", "En direct"];
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const noise of NOISE_PREFIXES) {
        if (name === noise) {
          name = "";
          stripped = true;
        } else if (name.startsWith(noise + " ")) {
          name = name.slice(noise.length).trim();
          stripped = true;
        }
      }
    }
    return name.trim();
  };

  // Si aucun vrai nom de compétition n'est trouvé pour un match (ex. la page ne le
  // réaffiche pas quand elle enchaîne sur la même compétition que la page précédente,
  // seul l'en-tête du tableau se répète), on réutilise le dernier nom trouvé — beaucoup
  // plus fiable que de laisser un résidu d'en-tête ("Événements en direct" etc.) ou un
  // champ vide, puisque les matchs consécutifs appartiennent très souvent à la même
  // compétition.
  let lastKnownLigue = "";
  const resolveLigue = (markerStart) => {
    const detected = detectLeagueName(markerStart);
    // un nom de compétition plausible fait au moins 3 caractères — en dessous, c'est
    // presque certainement un résidu parasite (ex. une lettre isolée), pas un vrai nom
    if (detected && detected.length >= 3) {
      lastKnownLigue = detected;
      return detected;
    }
    return lastKnownLigue;
  };

  const firstDate = (block) => {
    const m = block.match(/\d{2}\/\d{2}/);
    return m ? m[0] : "date inconnue";
  };

  blocks.forEach((block, bi) => {
    const teamRe = /\(\/fr\/team\/view\/(\d+)\)/g;
    const idMatches = [...block.matchAll(teamRe)];
    if (idMatches.length < 2) return;
    const [m1, m2] = idMatches;

    const zoneHome = block.slice(0, m1.index).toLowerCase().replace(/\s+/g, " ");
    const zoneAway = block.slice(m1.index + m1[0].length, m2.index).toLowerCase().replace(/\s+/g, " ");

    // score final (buts) — apparaît toujours juste entre les deux liens d'équipe, avant
    // le nom de l'équipe extérieure, ex. "...Manta FC (/fr/team/view/2773) 0 - 0
    // Orense..." → premier couple "X - Y" rencontré dans cette zone
    const scoreMatch = zoneAway.match(/(\d+)\s*-\s*(\d+)/);
    const butsHome = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
    const butsAway = scoreMatch ? parseInt(scoreMatch[2], 10) : null;

    const tail = block.slice(m2.index + m2[0].length);
    const tailRaw = tail;

    let cornersHome, cornersAway;
    let half1Home = null, half1Away = null, inlineHalfFound = false;
    let remainderForAttack;

    const inlineMatch = tailRaw.match(inlineCornerHalfRe);
    if (inlineMatch) {
      cornersHome = parseInt(inlineMatch[1], 10);
      cornersAway = parseInt(inlineMatch[2], 10);
      half1Home = parseInt(inlineMatch[3], 10);
      half1Away = parseInt(inlineMatch[4], 10);
      inlineHalfFound = true;
      remainderForAttack = tailRaw.slice(inlineMatch.index + inlineMatch[0].length);
    } else {
      // repli : pas de mi-temps inline détectée → on retire toutes les parenthèses et
      // on prend le premier couple "X - Y" comme corners (comportement historique)
      const stripped = tailRaw.replace(/\(\s*\d+\s*-\s*\d+\s*\)/g, "");
      const dashRe = /(\d+)[ \t]*-[ \t]*(\d+)/g;
      const pairs = [...stripped.matchAll(dashRe)];
      if (!pairs.length) return;
      cornersHome = parseInt(pairs[0][1], 10);
      cornersAway = parseInt(pairs[0][2], 10);
      remainderForAttack = stripped.slice(pairs[0].index + pairs[0][0].length);
    }

    // attaques dangereuses : le couple numérique restant après avoir retiré corners (+ mi-temps)
    const remainderStripped = remainderForAttack.replace(/\(\s*\d+\s*-\s*\d+\s*\)/g, "");
    const attackPairs = [...remainderStripped.matchAll(/(\d+)[ \t]*-[ \t]*(\d+)/g)];
    const hasAttack = attackPairs.length > 0;
    const attackPair = hasAttack ? attackPairs[attackPairs.length - 1] : null;
    const attHome = hasAttack ? parseInt(attackPair[1], 10) : null;
    const attAway = hasAttack ? parseInt(attackPair[2], 10) : null;

    // "Temps plein" ou un marqueur de minute (ex. "75'") signale normalement un match
    // terminé ; mais certaines lignes n'ont AUCUN marqueur alors que le match est bien
    // joué (bug d'affichage TotalCorner) — dans ce cas, la présence de VRAIES données
    // à la fois pour les corners ET les attaques est une preuve suffisante (un match à
    // venir n'a jamais de vraie donnée d'attaques, juste un "-")
    const hasStatusMarker = /Temps\s*\n?\s*plein/i.test(block) || /\b\d{1,3}\s*'/.test(block);
    const finished = hasStatusMarker || hasAttack;
    if (!finished) return;

    const matchWord = (zone) => targetWords.some((w) => zone.includes(w));
    const isHome = target && (zoneHome.includes(target) || matchWord(zoneHome));
    const isAway = target && (zoneAway.includes(target) || matchWord(zoneAway));

    if (isHome || isAway) {
      const result = {
        id: uid(),
        obtenus: String(isHome ? cornersHome : cornersAway),
        concedes: String(isHome ? cornersAway : cornersHome),
        lieu: isHome ? "D" : "E",
        attDangObtenus: hasAttack ? String(isHome ? attHome : attAway) : "",
        attDangConcedes: hasAttack ? String(isHome ? attAway : attHome) : "",
        corners1MTObtenus: "",
        corners1MTConcedes: "",
        corners2MTObtenus: "",
        corners2MTConcedes: "",
        butsObtenus: butsHome !== null ? String(isHome ? butsHome : butsAway) : "",
        butsConcedes: butsHome !== null ? String(isHome ? butsAway : butsHome) : "",
        ligue: resolveLigue(blockMarkerStarts[bi]),
        date: firstDate(block) === "date inconnue" ? "" : firstDate(block),
      };
      if (inlineHalfFound) {
        const mt1Obt = isHome ? half1Home : half1Away;
        const mt1Conc = isHome ? half1Away : half1Home;
        const totalObt = isHome ? cornersHome : cornersAway;
        const totalConc = isHome ? cornersAway : cornersHome;
        result.corners1MTObtenus = String(mt1Obt);
        result.corners1MTConcedes = String(mt1Conc);
        result.corners2MTObtenus = String(Math.max(totalObt - mt1Obt, 0));
        result.corners2MTConcedes = String(Math.max(totalConc - mt1Conc, 0));
      } else {
        // repli ancien format : tenter l'association par zone de bulles (uniquement si
        // le comptage correspond exactement — sinon on ne devine pas l'alignement)
        result._isHome = isHome;
        result._cornersHome = cornersHome;
        result._cornersAway = cornersAway;
        const blockPos = blockStarts[bi];
        let owningZone = null;
        for (const z of zones) {
          if (z.end <= blockPos && (!owningZone || z.end > owningZone.end)) owningZone = z;
        }
        result._zone = owningZone;
      }
      results.push(result);
    } else {
      skipped.push(`match du ${firstDate(block)}`);
    }
  });

  // repli ancien format : 2ème mi-temps = Total − 1ère mi-temps, via la zone de bulles
  // associée — seulement pour les résultats qui n'ont pas déjà une mi-temps inline, et
  // seulement si le nombre de matchs de la zone correspond exactement à son nombre de bulles
  const byZone = new Map();
  results.forEach((r) => {
    if (!r._zone) return;
    if (!byZone.has(r._zone)) byZone.set(r._zone, []);
    byZone.get(r._zone).push(r);
  });
  byZone.forEach((group, zone) => {
    if (group.length !== zone.bubbles.length) return;
    group.forEach((r, i) => {
      const [homeHalf, awayHalf] = zone.bubbles[i];
      const mt1Obt = r._isHome ? homeHalf : awayHalf;
      const mt1Conc = r._isHome ? awayHalf : homeHalf;
      const totalObt = r._isHome ? r._cornersHome : r._cornersAway;
      const totalConc = r._isHome ? r._cornersAway : r._cornersHome;
      r.corners1MTObtenus = String(mt1Obt);
      r.corners1MTConcedes = String(mt1Conc);
      r.corners2MTObtenus = String(Math.max(totalObt - mt1Obt, 0));
      r.corners2MTConcedes = String(Math.max(totalConc - mt1Conc, 0));
    });
  });
  results.forEach((r) => {
    delete r._isHome;
    delete r._cornersHome;
    delete r._cornersAway;
    delete r._zone;
  });

  const halvesCount = results.filter((r) => r.corners1MTObtenus !== "").length;
  return { results, skipped, halvesCount };
}

/* Les dates extraites de TotalCorner sont au format "MM/JJ", sans année (l'année n'est
   jamais affichée sur le site). On la déduit à partir de l'ordre chronologique : les
   résultats sont toujours du plus récent au plus ancien, donc si le mois d'un match est
   PLUS GRAND que celui du match juste avant lui (en remontant dans le temps), c'est qu'on
   vient de passer une frontière d'année (ex. de janvier on retombe sur décembre de
   l'année précédente) — on décrémente alors l'année déduite. Fiable tant que la liste
   ne saute pas une année entière d'un coup (jamais le cas ici, page par page). */
/* Le nom de l'équipe figure toujours en haut de la page TotalCorner, dans le titre
   "{Équipe} Stats et résultats des corners" — on peut donc le détecter automatiquement
   plutôt que d'obliger à le taper à la main (certains noms contiennent des caractères
   peu pratiques à saisir sur un clavier mobile, ex. des idéogrammes). */
function detectTeamNameFromText(text) {
  const idx = text.indexOf("Stats et résultats des corners");
  if (idx === -1) return "";
  const before = text.slice(Math.max(0, idx - 120), idx);
  const nm = before.match(/([A-ZÀ-ÖØ-Þ\p{Script=Han}][\p{L}\d\s\-'\u2019.]*)$/u);
  return nm ? nm[1].trim() : "";
}

function inferAbsoluteDates(results, today = new Date()) {
  let year = today.getFullYear();
  let prevMonth = today.getMonth() + 1;
  return results.map((r) => {
    if (!r.date) return { ...r, isoDate: "" };
    const [mm, dd] = r.date.split("/").map((n) => parseInt(n, 10));
    if (!mm || !dd) return { ...r, isoDate: "" };
    if (mm > prevMonth) year -= 1;
    prevMonth = mm;
    const isoDate = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return { ...r, isoDate };
  });
}

function RawExtractTotalCorner({ teamName, color, onImport, onTeamNameDetected }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const run = () => {
    const detectedName = detectTeamNameFromText(text);
    const typedName = (teamName || "").trim();
    let usedName = typedName;
    let results = [];
    let skipped = [];
    let halvesCount = 0;
    let usedFallback = false;

    if (typedName) {
      ({ results, skipped, halvesCount } = parseTotalCornerBlock(text, typedName));
    }
    if (!results.length && detectedName && detectedName.toLowerCase() !== typedName.toLowerCase()) {
      const retry = parseTotalCornerBlock(text, detectedName);
      if (retry.results.length) {
        ({ results, skipped, halvesCount } = retry);
        usedName = detectedName;
        usedFallback = true;
      }
    }
    if (!results.length && !typedName && detectedName) {
      const retry = parseTotalCornerBlock(text, detectedName);
      results = retry.results;
      skipped = retry.skipped;
      halvesCount = retry.halvesCount;
      usedName = detectedName;
      usedFallback = true;
    }

    if (!results.length) {
      setError(
        typedName
          ? `Aucun match reconnu ni pour "${typedName}"${detectedName ? ` ni pour "${detectedName}" (détecté dans le texte)` : ""} — soit le nom ne correspond pas, soit le copier-coller n'a pas gardé les liens nécessaires au repérage.`
          : "Aucun nom d'équipe détecté dans ce texte et aucun nom tapé — renseigne le nom de l'équipe ci-dessus."
      );
      return;
    }
    onImport(results);
    if (usedFallback && onTeamNameDetected) onTeamNameDetected(usedName);
    const halvesMsg = halvesCount === results.length
      ? " · mi-temps récupérées pour tous"
      : halvesCount > 0
      ? ` · mi-temps récupérées pour ${halvesCount}/${results.length}`
      : " · aucune mi-temps détectée (recolle via Xodo pour les récupérer)";
    const nameMsg = usedFallback ? ` · nom d'équipe détecté automatiquement : "${usedName}"` : "";
    setInfo(`${results.length} match${results.length > 1 ? "s" : ""} importé${results.length > 1 ? "s" : ""} (corners + att. dangereuses)${halvesMsg}${nameMsg}${skipped.length ? ` · ${skipped.length} ligne(s) ignorée(s)` : ""}. Vérifie le résultat avant de t'y fier.`);
    setError("");
    setText("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ fontSize: 10.5, color, background: "transparent", border: `1px solid ${color}55`, borderRadius: 6, padding: "3px 8px", cursor: "pointer", flexShrink: 0 }}>
        Extraction TotalCorner
      </button>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, background: C.bg, border: `1px solid ${color}55`, borderRadius: 8, padding: 8, gridColumn: "1 / -1" }}>
      <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.4 }}>
        Colle le texte copié depuis la page stats corners de l'équipe sur TotalCorner. Repère les matchs de{" "}
        <b style={{ color: C.text }}>{teamName || "l'équipe détectée automatiquement dans le texte"}</b> et lit corners{" "}
        <b>et</b> attaques dangereuses en même temps — le nom de l'équipe n'est plus obligatoire, il est lu directement
        dans le titre du texte collé si le champ ci-dessus est vide ou ne correspond à rien.{" "}
        <b style={{ color: C.fragile }}>Nécessite que le copier-coller conserve les liens du
        site</b> (ça ne marche pas si tu passes par une capture d'écran/OCR) — <b style={{ color: C.fragile }}>vérifie
        toujours le résultat</b>.
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Colle ici le texte copié depuis TotalCorner..." rows={8} style={{ ...inputStyle, resize: "vertical", fontSize: 12 }} />
      {error && <div style={{ fontSize: 11, color: C.fragile }}>{error}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={run} style={{ flex: 1, background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 6, padding: "6px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          Extraire
        </button>
        <button onClick={() => { setOpen(false); setError(""); }} style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 10px", color: C.dim, fontSize: 12, cursor: "pointer" }}>
          Annuler
        </button>
      </div>
      {info && <div style={{ fontSize: 11, color: C.jouable }}>{info}</div>}
    </div>
  );
}

function PdfExtractTotalCorner({ teamName, color, onImport, onTeamNameDetected }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const inputId = useMemo(() => `pdf-import-${uid()}`, []);

  const run = async () => {
    if (!file) {
      setError("Choisis d'abord un fichier PDF.");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const text = await extractPdfText(file, (i, total) => setProgress(`page ${i}/${total}`));
      const detectedName = detectTeamNameFromText(text);
      const typedName = (teamName || "").trim();

      // Le nom de l'équipe figure dans le PDF lui-même — on l'utilise en priorité s'il
      // n'y a rien de tapé, et en repli automatique si ce qui est tapé ne matche rien
      // (utile pour les noms avec des caractères peu pratiques à saisir).
      let usedName = typedName;
      let results = [];
      let skipped = [];
      let halvesCount = 0;
      let usedFallback = false;

      if (typedName) {
        ({ results, skipped, halvesCount } = parseTotalCornerBlock(text, typedName));
      }
      if (!results.length && detectedName && detectedName.toLowerCase() !== typedName.toLowerCase()) {
        const retry = parseTotalCornerBlock(text, detectedName);
        if (retry.results.length) {
          ({ results, skipped, halvesCount } = retry);
          usedName = detectedName;
          usedFallback = true;
        }
      }
      if (!results.length && !typedName && detectedName) {
        const retry = parseTotalCornerBlock(text, detectedName);
        results = retry.results;
        skipped = retry.skipped;
        halvesCount = retry.halvesCount;
        usedName = detectedName;
        usedFallback = true;
      }

      if (!results.length) {
        setError(
          typedName
            ? `Aucun match reconnu ni pour "${typedName}"${detectedName ? ` ni pour "${detectedName}" (détecté dans le PDF)` : ""} — vérifie que c'est bien la page stats corners de la bonne équipe.`
            : "Aucun nom d'équipe détecté dans ce PDF et aucun nom tapé — renseigne le nom de l'équipe ci-dessus."
        );
        setBusy(false);
        return;
      }
      const withDates = inferAbsoluteDates(results);
      let finalResults = withDates;
      if (dateFrom || dateTo) {
        finalResults = withDates.filter((r) => {
          if (!r.isoDate) return false;
          if (dateFrom && r.isoDate < dateFrom) return false;
          if (dateTo && r.isoDate > dateTo) return false;
          return true;
        });
        if (!finalResults.length) {
          setError(`Aucun match dans l'intervalle demandé (${results.length} matchs trouvés au total dans le PDF, mais aucun entre ces deux dates).`);
          setBusy(false);
          return;
        }
      }
      onImport(finalResults);
      if (usedFallback && onTeamNameDetected) onTeamNameDetected(usedName);
      const halvesMsg = halvesCount === results.length ? " · mi-temps récupérées pour tous" : halvesCount > 0 ? ` · mi-temps récupérées pour ${halvesCount}/${results.length}` : "";
      const rangeMsg = dateFrom || dateTo ? ` (filtré sur l'intervalle demandé, ${results.length} trouvés au total dans le PDF)` : "";
      const nameMsg = usedFallback ? ` · nom d'équipe détecté automatiquement : "${usedName}"` : "";
      setInfo(`${finalResults.length} match${finalResults.length > 1 ? "s" : ""} importé${finalResults.length > 1 ? "s" : ""}${rangeMsg}${halvesMsg}${nameMsg}${skipped.length ? ` · ${skipped.length} ligne(s) ignorée(s)` : ""}. Vérifie le résultat avant de t'y fier.`);
      setFile(null);
      setOpen(false);
    } catch (e) {
      setError("Échec de la lecture du PDF — vérifie que c'est bien un fichier PDF exporté depuis la page stats corners de TotalCorner (Imprimer → Enregistrer en PDF).");
    }
    setBusy(false);
    setProgress("");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ fontSize: 10.5, color, background: "transparent", border: `1px solid ${color}55`, borderRadius: 6, padding: "3px 8px", cursor: "pointer", flexShrink: 0 }}>
        Extraction PDF
      </button>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, background: C.bg, border: `1px solid ${color}55`, borderRadius: 8, padding: 8, gridColumn: "1 / -1" }}>
      <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.4 }}>
        Choisis directement le PDF exporté depuis la page stats corners de TotalCorner (menu Imprimer du navigateur →
        « Enregistrer en PDF ») pour <b style={{ color: C.text }}>{teamName || "l'équipe détectée automatiquement dans le PDF"}</b> —
        plus besoin de passer par Xodo. Le nom de l'équipe n'est plus obligatoire : il est lu directement dans le titre
        du PDF si le champ ci-dessus est vide ou ne correspond à rien. Optionnel : limite à un intervalle de dates
        précis (sinon tout le PDF est traité).{" "}
        <b style={{ color: C.fragile }}>Vérifie toujours le résultat.</b>
      </div>
      <input id={inputId} type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files && e.target.files[0])} style={{ fontSize: 11, color: C.dim }} />
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <label style={{ fontSize: 10, color: C.faint, flexShrink: 0 }}>Du</label>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...inputStyle, fontSize: 11, padding: "5px 6px" }} />
        <label style={{ fontSize: 10, color: C.faint, flexShrink: 0 }}>au</label>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...inputStyle, fontSize: 11, padding: "5px 6px" }} />
      </div>
      {error && <div style={{ fontSize: 11, color: C.fragile }}>{error}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={run} disabled={busy} style={{ flex: 1, background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 6, padding: "6px", fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : null} {busy ? progress || "Lecture…" : "Extraire"}
        </button>
        <button onClick={() => { setOpen(false); setError(""); setFile(null); }} disabled={busy} style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 10px", color: C.dim, fontSize: 12, cursor: "pointer" }}>
          Annuler
        </button>
      </div>
      {info && <div style={{ fontSize: 11, color: C.jouable }}>{info}</div>}
    </div>
  );
}

function MatchHistoryRows({ matches, setMatches, color, teamName, useAdvanced, onToggleAdvanced, excludedLigues, onToggleLigue, onTeamNameDetected }) {
  const update = (id, next) => setMatches(matches.map((m) => (m.id === id ? next : m)));
  const remove = (id) => setMatches(matches.filter((m) => m.id !== id));
  // liste dynamique des compétitions présentes dans CET historique — comme le filtre de
  // TotalCorner, pas figé sur 3 catégories fixes
  const ligueCounts = {};
  matches.forEach((m) => {
    const key = m.ligue || "(non identifiée)";
    ligueCounts[key] = (ligueCounts[key] || 0) + 1;
  });
  const ligueList = Object.entries(ligueCounts).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <div style={{ fontSize: 10, color: C.faint, fontFamily: FONT_MONO }}>du plus récent (haut) au plus ancien (bas)</div>
        <div style={{ display: "flex", gap: 6 }}>
          <RawExtractTotalCorner teamName={teamName} color={color} onImport={(parsed) => setMatches([...parsed, ...matches])} onTeamNameDetected={onTeamNameDetected} />
          <PdfExtractTotalCorner teamName={teamName} color={color} onImport={(parsed) => setMatches([...parsed, ...matches])} onTeamNameDetected={onTeamNameDetected} />
          {matches.length > 1 && (
            <button
              onClick={() => setMatches([...matches].reverse())}
              style={{ fontSize: 10, color: C.faint, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "2px 6px", cursor: "pointer", flexShrink: 0 }}
            >
              Inverser
            </button>
          )}
        </div>
      </div>
      <button
        onClick={onToggleAdvanced}
        title={useAdvanced ? "Désactive le calcul (les valeurs déjà saisies restent, mais ne sont plus utilisées)" : "Active le calcul à partir des tirs/attaques dangereuses saisis"}
        style={{ alignSelf: "flex-start", fontSize: 10, color: useAdvanced ? color : C.faint, background: useAdvanced ? color + "18" : "transparent", border: `1px ${useAdvanced ? "solid" : "dashed"} ${useAdvanced ? color + "55" : C.line}`, borderRadius: 6, padding: "2px 6px", cursor: "pointer" }}
      >
        {useAdvanced ? "✓ activé" : "+ activer"} tirs, att. dangereuses & corners par mi-temps (optionnel)
      </button>
      {ligueList.length > 1 && (
        <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ fontSize: 10, color: C.faint }}>compétitions à inclure dans le calcul :</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {ligueList.map(([name, count]) => {
              const active = !excludedLigues.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => onToggleLigue(name)}
                  title={name}
                  style={{
                    fontSize: 10,
                    color: active ? C.jouable : C.faint,
                    background: active ? C.jouable + "18" : "transparent",
                    border: `1px solid ${active ? C.jouable + "55" : C.line}`,
                    borderRadius: 6,
                    padding: "3px 7px",
                    cursor: "pointer",
                    maxWidth: 160,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {active ? "✓ " : ""}{name} ({count})
                </button>
              );
            })}
          </div>
        </div>
      )}
      {matches.map((m, i) => (
        <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: C.faint, width: 13, fontFamily: FONT_MONO, flexShrink: 0 }}>{i + 1}</span>
            <NumInput value={m.obtenus} onChange={(v) => update(m.id, { ...m, obtenus: v })} placeholder="obt." accent={color} />
            <NumInput value={m.concedes} onChange={(v) => update(m.id, { ...m, concedes: v })} placeholder="conc." accent={color} />
            <div style={{ display: "flex", flexShrink: 0, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.line}` }}>
              {["D", "E"].map((v) => (
                <button
                  key={v}
                  onClick={() => update(m.id, { ...m, lieu: m.lieu === v ? "" : v })}
                  title={v === "D" ? "Domicile" : "Extérieur"}
                  style={{ width: 20, height: 30, fontSize: 10.5, fontWeight: 700, border: "none", background: m.lieu === v ? color + "33" : C.surface2, color: m.lieu === v ? color : C.faint, cursor: "pointer" }}
                >
                  {v}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={m.ligue || ""}
              onChange={(e) => update(m.id, { ...m, ligue: e.target.value })}
              placeholder="compétition"
              title={m.ligue || "Compétition non détectée — tape le nom pour pouvoir filtrer dessus"}
              style={{ width: 74, flexShrink: 0, background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 6, padding: "0 6px", height: 30, color: m.ligue ? C.text : C.faint, fontFamily: FONT_BODY, fontSize: 10, outline: "none" }}
            />
            <IconBtn onClick={() => remove(m.id)} color={C.faint} title="Supprimer"><Trash2 size={13} /></IconBtn>
          </div>
          {useAdvanced && (
            <>
              <div style={{ display: "flex", gap: 5, alignItems: "center", paddingLeft: 18 }}>
                <NumInput value={m.tirsObtenus || ""} onChange={(v) => update(m.id, { ...m, tirsObtenus: v })} placeholder="tirs obt." accent={C.faint} />
                <NumInput value={m.tirsConcedes || ""} onChange={(v) => update(m.id, { ...m, tirsConcedes: v })} placeholder="tirs conc." accent={C.faint} />
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center", paddingLeft: 18 }}>
                <NumInput value={m.attDangObtenus || ""} onChange={(v) => update(m.id, { ...m, attDangObtenus: v })} placeholder="att. dang. obt." accent={C.faint} />
                <NumInput value={m.attDangConcedes || ""} onChange={(v) => update(m.id, { ...m, attDangConcedes: v })} placeholder="att. dang. conc." accent={C.faint} />
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center", paddingLeft: 18 }}>
                <NumInput value={m.corners1MTObtenus || ""} onChange={(v) => update(m.id, { ...m, corners1MTObtenus: v })} placeholder="corners 1MT obt." accent={C.faint} />
                <NumInput value={m.corners1MTConcedes || ""} onChange={(v) => update(m.id, { ...m, corners1MTConcedes: v })} placeholder="corners 1MT conc." accent={C.faint} />
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center", paddingLeft: 18 }}>
                <NumInput value={m.corners2MTObtenus || ""} onChange={(v) => update(m.id, { ...m, corners2MTObtenus: v })} placeholder="corners 2MT obt." accent={C.faint} />
                <NumInput value={m.corners2MTConcedes || ""} onChange={(v) => update(m.id, { ...m, corners2MTConcedes: v })} placeholder="corners 2MT conc." accent={C.faint} />
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center", paddingLeft: 18 }}>
                <NumInput value={m.butsObtenus || ""} onChange={(v) => update(m.id, { ...m, butsObtenus: v })} placeholder="buts obt." accent={C.faint} />
                <NumInput value={m.butsConcedes || ""} onChange={(v) => update(m.id, { ...m, butsConcedes: v })} placeholder="buts conc." accent={C.faint} />
              </div>
            </>
          )}
        </div>
      ))}
      <button
        onClick={() => setMatches([{ id: uid(), obtenus: "", concedes: "", lieu: "", tirsObtenus: "", tirsConcedes: "", attDangObtenus: "", attDangConcedes: "", corners1MTObtenus: "", corners1MTConcedes: "", corners2MTObtenus: "", corners2MTConcedes: "", butsObtenus: "", butsConcedes: "", ligue: "", date: "" }, ...matches])}
        style={{ ...addRowStyle(), marginTop: 0, padding: "7px", fontSize: 12 }}
      >
        <Plus size={12} /> Ajouter un match
      </button>
    </div>
  );
}

/* Classification indicative de la volatilité — seuils empiriques (pas de norme officielle),
   à ajuster si l'expérience montre qu'ils ne collent pas à la réalité des corners */
function volatiliteLabel(v) {
  if (v < 2) return { label: "Faible", color: C.solide };
  if (v < 3.5) return { label: "Moyenne", color: C.jouable };
  return { label: "Forte", color: C.fragile };
}

function VolBadge({ vol, volSource }) {
  const { label, color } = volatiliteLabel(vol);
  const isEstimated = volSource === "estimée";
  return (
    <span
      title={isEstimated ? "Approximation √moyenne — pas la vraie dispersion observée" : "Basée sur l'historique de matchs réel"}
      style={{
        background: isEstimated ? "transparent" : `${color}22`,
        color,
        border: `1px ${isEstimated ? "dashed" : "solid"} ${color}55`,
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        fontFamily: FONT_BODY,
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
      }}
    >
      {isEstimated && "≈ "}vol. {label}
      {isEstimated && <span style={{ fontWeight: 500, opacity: 0.85 }}> (estimée)</span>}
    </span>
  );
}

function TeamProfileForm({ team, setTeam, color, label }) {
  const setMatches = (matches) => setTeam((prev) => ({ ...prev, matches }));
  // filtre compétition : appliqué UNIQUEMENT au calcul, la liste des matchs reste
  // visible/éditable en entier quel que soit le filtre choisi
  const excludedLigues = team.excludedLigues || [];
  const filteredMatches = excludedLigues.length ? team.matches.filter((m) => !excludedLigues.includes(m.ligue || "(non identifiée)")) : team.matches;
  const toggleLigue = (name) =>
    setTeam({ ...team, excludedLigues: excludedLigues.includes(name) ? excludedLigues.filter((l) => l !== name) : [...excludedLigues, name] });
  const stats = computeHistoryStats(filteredMatches, 0.25, !!team.useAdvanced);
  const useHistory = team.mode === "historique";

  return (
    <div style={{ background: C.surface2, border: `1px solid ${color}44`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 10.5, color: C.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
        </div>
        <div style={{ display: "flex", background: C.bg, borderRadius: 8, padding: 2 }}>
          {["moyennes", "historique"].map((m) => (
            <button
              key={m}
              onClick={() => setTeam({ ...team, mode: m })}
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                padding: "4px 8px",
                borderRadius: 6,
                border: "none",
                background: team.mode === m ? color + "22" : "transparent",
                color: team.mode === m ? color : C.faint,
                cursor: "pointer",
              }}
            >
              {m === "moyennes" ? "Moyennes" : "Historique"}
            </button>
          ))}
        </div>
      </div>

      <TextInput value={team.nom} onChange={(v) => setTeam({ ...team, nom: v })} placeholder="Nom de l'équipe" accent={color} />

      {!useHistory ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Obtenus/match">
            <NumInput value={team.obtenus} onChange={(v) => setTeam({ ...team, obtenus: v })} placeholder="4.50" accent={color} />
          </Field>
          <Field label="Concédés/match">
            <NumInput value={team.concedes} onChange={(v) => setTeam({ ...team, concedes: v })} placeholder="5.69" accent={color} />
          </Field>
          <Field label="Part des corners %">
            <NumInput value={team.part} onChange={(v) => setTeam({ ...team, part: v })} placeholder="44" accent={color} />
          </Field>
          <Field label="Diff. EWMA">
            <NumInput value={team.ewma} onChange={(v) => setTeam({ ...team, ewma: v })} placeholder="-0.94" accent={color} />
          </Field>
        </div>
      ) : (
        <>
          <MatchHistoryRows
            matches={team.matches}
            setMatches={setMatches}
            color={color}
            teamName={team.nom}
            useAdvanced={!!team.useAdvanced}
            onToggleAdvanced={() => setTeam({ ...team, useAdvanced: !team.useAdvanced })}
            excludedLigues={excludedLigues}
            onToggleLigue={toggleLigue}
            onTeamNameDetected={(nom) => setTeam((prev) => ({ ...prev, nom }))}
          />
          {stats ? (
            <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim, display: "flex", flexDirection: "column", gap: 3 }}>
              <div>Calculé sur <b style={{ color: C.text }}>{stats.n}</b> match{stats.n > 1 ? "s" : ""} <span style={{ color: C.faint }}>(tous lieux confondus{excludedLigues.length ? ` · ${excludedLigues.length} compétition${excludedLigues.length > 1 ? "s" : ""} exclue${excludedLigues.length > 1 ? "s" : ""}` : ""})</span></div>
              <div>moyenne obtenus <b style={{ color: C.text }}>{stats.moyObtenus.toFixed(2)}</b> · concédés <b style={{ color: C.text }}>{stats.moyConcedes.toFixed(2)}</b></div>
              <div>part des corners <b style={{ color: C.text }}>{stats.part.toFixed(0)}%</b> · EWMA <b style={{ color: C.text }}>{stats.ewma >= 0 ? "+" : ""}{stats.ewma.toFixed(2)}</b></div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                volatilité totale (écart-type) <b style={{ color: C.text }}>±{stats.volatilite.toFixed(2)}</b>
                <Pill color={volatiliteLabel(stats.volatilite).color}>{volatiliteLabel(stats.volatilite).label}</Pill>
              </div>
              {(() => {
                const s5 = computeHistoryStats(team.matches.slice(0, 5));
                const s10 = computeHistoryStats(team.matches.slice(0, 10));
                if (!s5 || team.matches.length < 5) return null;
                const diff = (s) => (s.moyObtenus - s.moyConcedes >= 0 ? "+" : "") + (s.moyObtenus - s.moyConcedes).toFixed(2);
                const mtDiff = (s, key) => {
                  const series = s && s[key];
                  if (!series) return null;
                  const d = series.moyObtenus - series.moyConcedes;
                  return (d >= 0 ? "+" : "") + d.toFixed(2);
                };
                const rows = [
                  { label: "Total", d5: diff(s5), d10: s10 && team.matches.length >= 10 ? diff(s10) : null },
                  { label: "1ère MT", d5: mtDiff(s5, "mt1Series"), d10: team.matches.length >= 10 ? mtDiff(s10, "mt1Series") : null },
                  { label: "2ème MT", d5: mtDiff(s5, "mt2Series"), d10: team.matches.length >= 10 ? mtDiff(s10, "mt2Series") : null },
                ];
                return (
                  <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5 }}>
                    <div style={{ fontSize: 10, color: C.faint, marginBottom: 2 }}>forme récente (diff. corners obtenus − concédés)</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      {rows.map(
                        (r) =>
                          r.d5 !== null && (
                            <div key={r.label} style={{ display: "flex", gap: 12 }}>
                              <span style={{ color: C.faint, minWidth: 52, display: "inline-block" }}>{r.label}</span>
                              <span>5 derniers : <b style={{ color: C.text }}>{r.d5}</b></span>
                              {r.d10 !== null && (
                                <span>10 derniers : <b style={{ color: C.text }}>{r.d10}</b></span>
                              )}
                            </div>
                          )
                      )}
                    </div>
                  </div>
                );
              })()}
              {stats.tirs && (
                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5 }}>
                  <div style={{ fontSize: 10, color: C.faint, marginBottom: 2 }}>
                    conversion tirs → corners (optionnel, sur {stats.tirs.n} match{stats.tirs.n > 1 ? "s" : ""})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {stats.tirs.ratioTotal !== null && (
                      <span>Total : <b style={{ color: C.text }}>{stats.tirs.ratioTotal.toFixed(2)}</b> corner/tir</span>
                    )}
                    {stats.tirs.ratioObtenu !== null && (
                      <span>Obtenu : <b style={{ color: C.text }}>{stats.tirs.ratioObtenu.toFixed(2)}</b> corner/tir ({stats.tirs.moyTirsObtenus.toFixed(1)} tirs/match)</span>
                    )}
                    {stats.tirs.ratioConcede !== null && (
                      <span>Concédé : <b style={{ color: C.text }}>{stats.tirs.ratioConcede.toFixed(2)}</b> corner/tir ({stats.tirs.moyTirsConcedes.toFixed(1)} tirs/match)</span>
                    )}
                  </div>
                </div>
              )}
              {stats.attDang && (
                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5 }}>
                  <div style={{ fontSize: 10, color: C.faint, marginBottom: 2 }}>
                    conversion att. dangereuses → corners (optionnel, sur {stats.attDang.n} match{stats.attDang.n > 1 ? "s" : ""})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {stats.attDang.ratioTotal !== null && (
                      <span>Total : <b style={{ color: C.text }}>{stats.attDang.ratioTotal.toFixed(2)}</b> corner/att.</span>
                    )}
                    {stats.attDang.ratioObtenu !== null && (
                      <span>Obtenu : <b style={{ color: C.text }}>{stats.attDang.ratioObtenu.toFixed(2)}</b> corner/att. ({stats.attDang.moyAttObtenus.toFixed(1)} att./match)</span>
                    )}
                    {stats.attDang.ratioConcede !== null && (
                      <span>Concédé : <b style={{ color: C.text }}>{stats.attDang.ratioConcede.toFixed(2)}</b> corner/att. ({stats.attDang.moyAttConcedes.toFixed(1)} att./match)</span>
                    )}
                  </div>
                </div>
              )}
              {(stats.mt1Series || stats.mt2Series) && (
                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5 }}>
                  <div style={{ fontSize: 10, color: C.faint, marginBottom: 2 }}>corners par mi-temps (optionnel) · tous lieux confondus</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {stats.mt1Series && (
                      <span>
                        1ère MT : <b style={{ color: C.text }}>{stats.mt1Series.moyObtenus.toFixed(2)}</b>/
                        <b style={{ color: C.text }}>{stats.mt1Series.moyConcedes.toFixed(2)}</b> · part{" "}
                        {stats.mt1Series.part.toFixed(0)}% · EWMA {stats.mt1Series.ewma >= 0 ? "+" : ""}
                        {stats.mt1Series.ewma.toFixed(2)} · vol ±{stats.mt1Series.volatilite.toFixed(2)}{" "}
                        <VolBadge vol={stats.mt1Series.volatilite} volSource="historique" />
                      </span>
                    )}
                    {stats.mt2Series && (
                      <span>
                        2ème MT : <b style={{ color: C.text }}>{stats.mt2Series.moyObtenus.toFixed(2)}</b>/
                        <b style={{ color: C.text }}>{stats.mt2Series.moyConcedes.toFixed(2)}</b> · part{" "}
                        {stats.mt2Series.part.toFixed(0)}% · EWMA {stats.mt2Series.ewma >= 0 ? "+" : ""}
                        {stats.mt2Series.ewma.toFixed(2)} · vol ±{stats.mt2Series.volatilite.toFixed(2)}{" "}
                        <VolBadge vol={stats.mt2Series.volatilite} volSource="historique" />
                      </span>
                    )}
                  </div>
                  {(() => {
                    const sig1 = stats.mt1Series && stats.mt1Series.n >= 3 ? computeVolumeSignal(stats.mt1Series) : null;
                    const sig2 = stats.mt2Series && stats.mt2Series.n >= 3 ? computeVolumeSignal(stats.mt2Series) : null;
                    if (!sig1 && !sig2) return null;
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                        {[
                          { label: "1MT", sig: sig1 },
                          { label: "2MT", sig: sig2 },
                        ].map(
                          ({ label, sig }) =>
                            sig && (
                              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ color: C.faint, minWidth: 30, display: "inline-block" }}>{label}</span>
                                <Pill color={sig.fort ? C.solide : C.jouable}>
                                  {sig.fort ? "🔥 handicap -0.75 / -1.0" : "handicap sécurisé -0.25"}
                                </Pill>
                                <span style={{ color: C.faint, fontSize: 10 }}>
                                  vol. projeté {sig.totalProjete.toFixed(2)} · ±{sig.vol.toFixed(2)}
                                </span>
                              </div>
                            )
                        )}
                        <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic" }}>
                          basé sur l'historique propre de {team.nom || "l'équipe"} uniquement (tous adversaires confondus) — le Comparateur affine ce signal en croisant avec l'adversaire du duel
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
              {stats.butsSeries && (
                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5 }}>
                  <div style={{ fontSize: 10, color: C.faint, marginBottom: 2 }}>buts — match complet (optionnel) · tous lieux confondus</div>
                  <div>
                    <b style={{ color: C.text }}>{stats.butsSeries.moyObtenus.toFixed(2)}</b>/
                    <b style={{ color: C.text }}>{stats.butsSeries.moyConcedes.toFixed(2)}</b> · part{" "}
                    {stats.butsSeries.part.toFixed(0)}% · EWMA {stats.butsSeries.ewma >= 0 ? "+" : ""}
                    {stats.butsSeries.ewma.toFixed(2)} · vol ±{stats.butsSeries.volatilite.toFixed(2)}{" "}
                    <VolBadge vol={stats.butsSeries.volatilite} volSource="historique" />
                  </div>
                  {(() => {
                    const form = stats.butsSeries.n >= 3 ? computeFormLabel(stats.butsSeries) : null;
                    if (!form) return null;
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <Pill color={form.color}>{form.label}</Pill>
                          <span style={{ color: C.faint, fontSize: 10 }}>ratio {form.ratio.toFixed(2)}× (EWMA / volatilité)</span>
                        </div>
                        <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic" }}>
                          contrairement au badge volume des corners (seuil fixe), ce badge s'appuie sur le ratio propre
                          à {team.nom || "l'équipe"} — plus adapté aux buts, plus rares et plus volatils par match que les corners
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
              {(stats.vndTotal || stats.vndMT1 || stats.vndMT2) && (
                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5 }}>
                  <div style={{ fontSize: 10, color: C.faint, marginBottom: 3 }}>duel des corners — Vic/Nul/Déf</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr repeat(4, auto)", gap: "2px 8px", fontSize: 11 }}>
                    <span style={{ color: C.faint }}></span>
                    <span style={{ color: C.faint }}>Vic</span>
                    <span style={{ color: C.faint }}>Nul</span>
                    <span style={{ color: C.faint }}>Déf</span>
                    <span style={{ color: C.faint }}>%vict.</span>
                    {[
                      { label: "Total", v: stats.vndTotal },
                      { label: "1ère MT", v: stats.vndMT1 },
                      { label: "2ème MT", v: stats.vndMT2 },
                    ].map(
                      ({ label, v }) =>
                        v && (
                          <React.Fragment key={label}>
                            <span>{label} ({v.n})</span>
                            <span style={{ color: C.solide }}>{v.vic}</span>
                            <span style={{ color: C.faint }}>{v.nul}</span>
                            <span style={{ color: C.fragile }}>{v.def}</span>
                            <span style={{ color: C.text, fontWeight: 700 }}>{v.pctVic.toFixed(0)}%</span>
                          </React.Fragment>
                        )
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: C.faint, fontFamily: FONT_BODY }}>Ajoute au moins un match pour calculer la part et l'EWMA réels.</div>
          )}
        </>
      )}
    </div>
  );
}

function LectureCroisee({ teamA, teamB, proj }) {
  const partAReal = teamA.part !== "" ? num(teamA.part) : null;
  const partBReal = teamB.part !== "" ? num(teamB.part) : null;
  const ewAReal = teamA.ewma !== "" ? num(teamA.ewma) : null;
  const ewBReal = teamB.ewma !== "" ? num(teamB.ewma) : null;

  const hasObtenusConcedes = (num(teamA.obtenus) || num(teamA.concedes) || num(teamB.obtenus) || num(teamB.concedes)) > 0;

  // repli : estimation à partir de obtenus/concédés quand la vraie part/EWMA manque
  const partEstimee = partAReal === null && partBReal === null && proj && proj.total > 0;
  const partA = partAReal !== null ? partAReal : partEstimee ? (proj.projA / proj.total) * 100 : null;
  const partB = partBReal !== null ? partBReal : partEstimee ? (proj.projB / proj.total) * 100 : null;

  const ewEstimee = ewAReal === null && ewBReal === null && hasObtenusConcedes;
  const ewA = ewAReal !== null ? ewAReal : ewEstimee ? num(teamA.obtenus) - num(teamA.concedes) : null;
  const ewB = ewBReal !== null ? ewBReal : ewEstimee ? num(teamB.obtenus) - num(teamB.concedes) : null;

  if (partA === null && partB === null && ewA === null && ewB === null) return null;

  const partDiff = (partB || 0) - (partA || 0);
  const ewDiff = (ewB || 0) - (ewA || 0);
  let dominant = null;
  if (Math.abs(partDiff) > 4 || Math.abs(ewDiff) > 0.5) {
    dominant = partDiff + ewDiff * 8 > 0 ? teamB.nom || "Équipe B" : teamA.nom || "Équipe A";
  }

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionTitle sub={partEstimee || ewEstimee ? "valeurs estimées si non renseignées" : undefined}>Lecture croisée</SectionTitle>
      {(partA !== null || partB !== null) && (
        <div>
          <SplitBar
            left={partA ?? 100 - (partB || 0)}
            right={partB ?? 100 - (partA || 0)}
            colorLeft={C.teamA}
            colorRight={C.teamB}
            labelLeft={`${(partA ?? 100 - (partB || 0)).toFixed(0)}%`}
            labelRight={`${(partB ?? 100 - (partA || 0)).toFixed(0)}%`}
          />
          {partEstimee && <div style={{ fontSize: 10, color: C.faint, marginTop: 3, fontFamily: FONT_MONO }}>part estimée (via projection)</div>}
        </div>
      )}
      {(ewA !== null || ewB !== null) && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 12 }}>
            <span style={{ color: C.teamA }}>{ewEstimee ? "diff." : "EWMA"} {ewA >= 0 ? "+" : ""}{(ewA || 0).toFixed(2)}</span>
            <span style={{ color: C.teamB }}>{ewEstimee ? "diff." : "EWMA"} {ewB >= 0 ? "+" : ""}{(ewB || 0).toFixed(2)}</span>
          </div>
          {ewEstimee && <div style={{ fontSize: 10, color: C.faint, marginTop: 3, fontFamily: FONT_MONO }}>différentiel brut estimé (obtenus − concédés, non lissé)</div>}
        </div>
      )}
      {dominant && (
        <div style={{ fontSize: 12.5, color: C.dim, lineHeight: 1.5 }}>
          <b style={{ color: C.text }}>{dominant}</b> domine le rapport de force sur les corners (part + tendance convergent dans le même sens).
        </div>
      )}
    </div>
  );
}

/* Force relative Elo (ClubElo) — marché 1X2, complémentaire aux corners/buts déjà
   couverts. Contrairement au reste de l'app (bâti uniquement sur l'historique propre
   de chaque équipe), l'Elo intègre indirectement TOUTE la pyramide du football
   européen via les matchs de coupes d'Europe qui relient les ligues entre elles —
   c'est ce qui permet de comparer deux équipes qui ne jouent jamais dans la même
   ligue (ex. Bodø/Glimt vs Celtic). Recherche manuelle (pas automatique) pour éviter
   de spammer l'API à chaque rendu, et les noms sont éditables car l'orthographe
   ClubElo peut différer de celle utilisée sur TotalCorner. */
function EloPanel({ teamAName, teamBName }) {
  const [nameA, setNameA] = useState(teamAName || "");
  const [nameB, setNameB] = useState(teamBName || "");
  const [eloA, setEloA] = useState(null);
  const [eloB, setEloB] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    setNameA(teamAName || "");
    setEloA(null);
    setSearched(false);
  }, [teamAName]);
  useEffect(() => {
    setNameB(teamBName || "");
    setEloB(null);
    setSearched(false);
  }, [teamBName]);

  const run = async () => {
    if (!nameA.trim() || !nameB.trim()) {
      setError("Renseigne le nom des deux équipes (celui utilisé par ClubElo, pas forcément identique à TotalCorner).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const [a, b] = await Promise.all([fetchClubElo(nameA), fetchClubElo(nameB)]);
      if (!a || !b) {
        setError(
          `Club introuvable sur ClubElo : ${!a ? `"${nameA}"` : ""}${!a && !b ? " et " : ""}${!b ? `"${nameB}"` : ""} — essaie une orthographe différente (ex. "Bodo/Glimt", "Celtic").`
        );
        setEloA(a);
        setEloB(b);
        setBusy(false);
        return;
      }
      setEloA(a);
      setEloB(b);
      setSearched(true);
    } catch (e) {
      setError("Impossible de contacter ClubElo pour le moment — réessaie dans un instant.");
    }
    setBusy(false);
  };

  const matchup = eloA && eloB ? computeEloMatchup(eloA.elo, eloB.elo, 100) : null;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionTitle sub="marché 1X2 · optionnel">Force relative (Elo — ClubElo)</SectionTitle>
      <div style={{ fontSize: 10.5, color: C.faint, lineHeight: 1.4 }}>
        Compare deux équipes même si elles ne jouent jamais dans la même ligue (ex. Bodø/Glimt vs Celtic) — via
        l'historique Elo public de <b style={{ color: C.text }}>ClubElo</b>, calibré par les matchs de coupes
        d'Europe qui relient les championnats entre eux.
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <TextInput value={nameA} onChange={setNameA} placeholder="Nom ClubElo équipe A" accent={C.teamA} />
        <TextInput value={nameB} onChange={setNameB} placeholder="Nom ClubElo équipe B" accent={C.teamB} />
      </div>
      <button
        onClick={run}
        disabled={busy}
        style={{ background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 6, padding: "7px", fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : null} {busy ? "Recherche…" : "Chercher force Elo"}
      </button>
      {error && <div style={{ fontSize: 11, color: C.fragile }}>{error}</div>}
      {searched && eloA && eloB && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 13 }}>
            <div>
              <div style={{ color: C.teamA, fontWeight: 700 }}>{eloA.club}</div>
              <div style={{ color: C.dim }}>Elo {eloA.elo.toFixed(0)}</div>
              <div style={{ color: C.faint, fontSize: 10 }}>{eloA.country}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ color: C.teamB, fontWeight: 700 }}>{eloB.club}</div>
              <div style={{ color: C.dim }}>Elo {eloB.elo.toFixed(0)}</div>
              <div style={{ color: C.faint, fontSize: 10 }}>{eloB.country}</div>
            </div>
          </div>
          {matchup && (
            <>
              <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 }}>
                <SplitBar
                  left={matchup.pHome * 100}
                  right={matchup.pAway * 100}
                  colorLeft={C.teamA}
                  colorRight={C.teamB}
                  labelLeft={`${(matchup.pHome * 100).toFixed(0)}%`}
                  labelRight={`${(matchup.pAway * 100).toFixed(0)}%`}
                />
                <div style={{ textAlign: "center", fontSize: 11, color: C.faint, marginTop: 6 }}>
                  Nul : {(matchup.pDraw * 100).toFixed(0)}% · écart Elo {matchup.diff >= 0 ? "+" : ""}{matchup.diff.toFixed(0)} (avantage terrain de {eloA.club} déjà inclus)
                </div>
              </div>
              <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic" }}>
                Probabilités approximatives dérivées de l'écart d'Elo (formule standard + modèle de nul simplifié) —
                pas la méthode exacte propriétaire de ClubElo, à prendre comme ordre de grandeur, pas comme cote
                officielle.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* Répond directement à "quelle équipe est favorite, et quelle mi-temps" : compare les
   deux synthèses (evaluateMiTempsHandicap pour 1MT et 2MT) et met en avant celle avec
   la confiance la plus nette (ratio marge/volatilité le plus élevé), plutôt que de
   laisser l'utilisateur comparer les deux panneaux à la main. */
function MiTempsRecommendation({ recMT1, recMT2, teamAName, teamBName, matchLabel, onAddBet }) {
  const MIN_N = 3;
  const candidates = [
    recMT1 && recMT1.n >= MIN_N ? { ...recMT1, half: "1ère MT" } : null,
    recMT2 && recMT2.n >= MIN_N ? { ...recMT2, half: "2ème MT" } : null,
  ].filter(Boolean);
  if (!candidates.length) return null;

  const best = candidates.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const other = candidates.find((c) => c !== best) || null;
  const favoriName = (name) => name || (best.favori === "A" ? "Équipe A" : "Équipe B");
  const bestFavoriName = favoriName(best.favori === "A" ? teamAName : teamBName);
  const otherFavoriName = other ? favoriName(other.favori === "A" ? teamAName : teamBName) : null;

  return (
    <div style={{ background: C.surface, border: `1px solid ${verdictColor(best.verdict)}55`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionTitle>🎯 Recommandation</SectionTitle>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: FONT_DISPLAY, fontSize: 21, fontWeight: 700, color: best.favori === "A" ? C.teamA : C.teamB }}>
          {bestFavoriName}
        </span>
        <span style={{ color: C.dim, fontSize: 13 }}>favori aux corners en</span>
        <span style={{ fontFamily: FONT_DISPLAY, fontSize: 21, fontWeight: 700 }}>{best.half}</span>
        <Pill color={verdictColor(best.verdict)}>{best.verdict}</Pill>
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>marge {best.marge.toFixed(2)} · ratio {best.ratio.toFixed(2)}×</span>
        {best.volumeSignal && (
          <Pill color={best.volumeSignal.fort ? C.solide : C.jouable}>
            {best.volumeSignal.fort ? "🔥 volume total -0.75/-1.0" : "volume total sécurisé -0.25"}
          </Pill>
        )}
      </div>
      {other && (
        <div style={{ fontSize: 11, color: C.faint, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
          {other.half} moins net : <b style={{ color: C.dim }}>{otherFavoriName}</b> favori, ratio {other.ratio.toFixed(2)}× ({other.verdict})
        </div>
      )}
      {onAddBet && (
        <button
          onClick={() =>
            onAddBet({
              category: "mi-temps",
              label: `${matchLabel} — ${bestFavoriName} favori corners ${best.half}`,
              cote: "",
              probUsed: null,
              edge: null,
              verdict: best.verdict,
            })
          }
          style={{ alignSelf: "flex-start", background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
        >
          <Plus size={13} /> Suivre cette reco
        </button>
      )}
    </div>
  );
}

/* Même visuel que la Lecture croisée + projection du total, mais pour les tirs ou les
   attaques dangereuses — entièrement optionnel, n'apparaît que si les deux équipes ont
   assez de données saisies. Contexte domicile/extérieur déjà pris en compte puisque
   seriesA/seriesB viennent de pickVenueStats, comme pour les corners. */
function SecondaryStatPanel({ label, unit, seriesA, seriesB, sourceA, sourceB, teamAName, teamBName, showHandicapSignal = false, showRatioVerdict = false, showFormLabels = false }) {
  if (!seriesA || !seriesB) return null;
  const proj = projection(seriesA.moyObtenus, seriesB.moyConcedes, seriesB.moyObtenus, seriesA.moyConcedes);
  const volCombined = seriesA.volatilite || seriesB.volatilite ? Math.sqrt(seriesA.volatilite ** 2 + seriesB.volatilite ** 2) : null;
  // signal croisé duel : volume projeté du MATCH (les deux équipes combinées via la
  // projection ci-dessus), pas seulement l'historique propre d'une équipe — répond au
  // fait qu'un handicap dépend aussi de ce que l'adversaire concède/produit
  const signal = showHandicapSignal ? volumeSignalFromValues(proj.total, volCombined) : null;
  // verdict ratio (marge / volatilité) — contrairement au signal volume ci-dessus, c'est
  // une mesure RELATIVE donc valable sur n'importe quel marché sans seuil à recalibrer
  // (utile typiquement pour les buts, où le volume absolu n'a pas de sens comparable
  // aux corners)
  const ratioVerdict = showRatioVerdict ? computeVerdict({ moyenne: proj.projA, ligne: proj.projB, volatilite: volCombined }) : null;
  const ratioFavori = ratioVerdict ? (ratioVerdict.sens === "Over" ? teamAName || "Équipe A" : teamBName || "Équipe B") : null;
  // forme individuelle de chaque équipe (Bonne forme/En forme/Neutre/Difficultés/En
  // perdition) — indépendant du duel, contrairement au verdict ci-dessus qui compare
  // les deux équipes entre elles
  const formA = showFormLabels ? computeFormLabel(seriesA) : null;
  const formB = showFormLabels ? computeFormLabel(seriesB) : null;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionTitle sub="optionnel">{label}</SectionTitle>

      <div>
        <SplitBar
          left={seriesA.part}
          right={seriesB.part}
          colorLeft={C.teamA}
          colorRight={C.teamB}
          labelLeft={`${seriesA.part.toFixed(0)}%`}
          labelRight={`${seriesB.part.toFixed(0)}%`}
        />
        <div style={{ fontSize: 10, color: C.faint, marginTop: 3, fontFamily: FONT_MONO }}>
          part des {label.toLowerCase()} · {teamAName || "A"} ({sourceA}, {seriesA.n}) / {teamBName || "B"} ({sourceB}, {seriesB.n})
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 12 }}>
        <span style={{ color: C.teamA }}>EWMA {seriesA.ewma >= 0 ? "+" : ""}{seriesA.ewma.toFixed(2)}</span>
        <span style={{ color: C.teamB }}>EWMA {seriesB.ewma >= 0 ? "+" : ""}{seriesB.ewma.toFixed(2)}</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.teamA }}>±{seriesA.volatilite.toFixed(2)}</span>
          <VolBadge vol={seriesA.volatilite} volSource="historique" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <VolBadge vol={seriesB.volatilite} volSource="historique" />
          <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.teamB }}>±{seriesB.volatilite.toFixed(2)}</span>
        </div>
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim }}>
        Projection {label.toLowerCase()} du match : <span style={{ color: C.teamA }}>{proj.projA.toFixed(2)}</span> +{" "}
        <span style={{ color: C.teamB }}>{proj.projB.toFixed(2)}</span> = <b style={{ color: C.text }}>{proj.total.toFixed(2)} {unit}</b>
        {volCombined && (
          <>
            <br />
            volatilité combinée estimée : ±{volCombined.toFixed(2)}
          </>
        )}
      </div>

      {signal && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: C.faint }}>signal duel :</span>
          <Pill color={signal.fort ? C.solide : C.jouable}>
            {signal.fort ? "🔥 handicap -0.75 / -1.0" : "handicap sécurisé -0.25"}
          </Pill>
          <span style={{ color: C.faint, fontSize: 10 }}>
            (volume projeté {signal.totalProjete.toFixed(2)} · ±{signal.vol.toFixed(2)} — les deux équipes combinées)
          </span>
        </div>
      )}

      {ratioVerdict && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: C.faint }}>verdict :</span>
          <Pill color={verdictColor(ratioVerdict.verdict)}>{ratioVerdict.verdict}</Pill>
          <span style={{ color: C.faint, fontSize: 10 }}>
            {ratioFavori} favori · marge {ratioVerdict.marge.toFixed(2)} · ratio {ratioVerdict.ratio.toFixed(2)}×
          </span>
        </div>
      )}

      {(formA || formB) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <span style={{ fontSize: 10, color: C.faint }}>forme individuelle (indépendante du duel) :</span>
          {formA && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: C.teamA, minWidth: 70 }}>{teamAName || "Équipe A"}</span>
              <Pill color={formA.color}>{formA.label}</Pill>
              <span style={{ color: C.faint, fontSize: 10 }}>ratio {formA.ratio.toFixed(2)}×</span>
            </div>
          )}
          {formB && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: C.teamB, minWidth: 70 }}>{teamBName || "Équipe B"}</span>
              <Pill color={formB.color}>{formB.label}</Pill>
              <span style={{ color: C.faint, fontSize: 10 }}>ratio {formB.ratio.toFixed(2)}×</span>
            </div>
          )}
          <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic", marginTop: 2 }}>
            même principe que dans le profil solo : contrairement au badge volume des corners (seuil fixe), ce badge
            s'appuie sur le ratio propre à chaque équipe — plus adapté aux buts, plus rares et plus volatils par
            match que les corners
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   TOTAL MATCH LINE ROW
--------------------------------------------------------------- */
function LigneRow({ ligne, onChange, onRemove, moyenne, fallbackVol, onAddBet, matchLabel }) {
  const volatilite = num(ligne.volatilite);
  const l = num(ligne.valeur);
  const { sens, marge, ratio, verdict, volSource, vol } = computeVerdict({ moyenne, ligne: l, volatilite, fallbackVol });
  const probPoisson = estimateProb(l, moyenne, sens);
  const probReel = ligne.pourcentage !== "" ? num(ligne.pourcentage) / 100 : null;
  const probUsed = probReel !== null ? probReel : probPoisson;
  const imp = impliedProb(ligne.cote);
  const edge = imp !== null ? (probUsed - imp) * 100 : null;

  return (
    <div style={{ background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ArcGauge ratio={ratio} verdict={verdict} />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700 }}>{sens} {l ? l.toFixed(1) : "—"}</span>
            <Pill color={verdictColor(verdict)}>{verdict}</Pill>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.dim, marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span>marge {marge.toFixed(2)} · ratio {ratio.toFixed(2)}×
            {volSource !== "manuelle" && <span style={{ color: C.faint }}> (vol. {volSource})</span>}</span>
            <VolBadge vol={vol} volSource={volSource} />
          </div>
        </div>
        <IconBtn onClick={onRemove} color={C.fragile} title="Supprimer"><Trash2 size={14} /></IconBtn>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Ligne">
          <NumInput value={ligne.valeur} onChange={(v) => onChange({ ...ligne, valeur: v })} placeholder="8.5" />
        </Field>
        <Field label="% réel (opt.)">
          <NumInput value={ligne.pourcentage} onChange={(v) => onChange({ ...ligne, pourcentage: v })} placeholder="app" />
        </Field>
        <Field label="Cote (opt.)">
          <NumInput value={ligne.cote} onChange={(v) => onChange({ ...ligne, cote: v })} placeholder="1.85" />
        </Field>
      </div>
      <Field label="Volatilité ± (opt.)">
        <NumInput value={ligne.volatilite} onChange={(v) => onChange({ ...ligne, volatilite: v })} placeholder="ex 3.4" />
      </Field>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.dim }}>
          Prob. {probReel !== null ? "réelle" : "Poisson"} : {(probUsed * 100).toFixed(0)}%
          {edge !== null && (
            <span style={{ color: edge >= 0 ? C.solide : C.fragile, marginLeft: 8, fontWeight: 700 }}>
              edge {edge >= 0 ? "+" : ""}{edge.toFixed(1)} pts
            </span>
          )}
        </div>
        <button
          onClick={() => onAddBet({ category: "total", label: `${matchLabel} — ${sens} ${l.toFixed(1)} (total)`, cote: ligne.cote, probUsed, edge, verdict })}
          style={{ background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
        >
          <Plus size={13} /> Suivre
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   INDIVIDUAL CORNER ROW
--------------------------------------------------------------- */
function IndividuelRow({ item, onChange, onRemove, onAddBet }) {
  const moyenne = num(item.moyenne);
  const volatilite = num(item.volatilite);
  const l = num(item.ligne);
  const { sens, marge, ratio, verdict, volSource, vol } = computeVerdict({ moyenne, ligne: l, volatilite });
  const probUsed = estimateProb(l, moyenne, sens);
  const imp = impliedProb(item.cote);
  const edge = imp !== null ? (probUsed - imp) * 100 : null;

  return (
    <div style={{ background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ArcGauge ratio={ratio} verdict={verdict} />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700 }}>{sens} {l ? l.toFixed(1) : "—"}</span>
            <Pill color={verdictColor(verdict)}>{verdict}</Pill>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.dim, marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span>marge {marge.toFixed(2)} · ratio {ratio.toFixed(2)}×
            {volSource !== "manuelle" && <span style={{ color: C.faint }}> (vol. {volSource === "estimée" ? "estimée √moy." : volSource})</span>}</span>
            <VolBadge vol={vol} volSource={volSource} />
          </div>
          {(item.sourceObtenus !== null && item.sourceObtenus !== undefined) && (
            <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: C.faint, marginTop: 2 }}>
              obtenu propre : <b style={{ color: C.dim }}>{num(item.sourceObtenus).toFixed(2)}</b> · concédé adversaire :{" "}
              <b style={{ color: C.dim }}>{num(item.sourceConcedes).toFixed(2)}</b> ({item.sourceCase})
            </div>
          )}
        </div>
        <IconBtn onClick={onRemove} color={C.fragile} title="Supprimer"><Trash2 size={14} /></IconBtn>
      </div>
      <Field label="Équipe">
        <TextInput value={item.nom} onChange={(v) => onChange({ ...item, nom: v })} placeholder="Nom de l'équipe" />
      </Field>
      <div className="grid grid-cols-4 gap-2">
        <Field label="Moyenne">
          <NumInput value={item.moyenne} onChange={(v) => onChange({ ...item, moyenne: v })} placeholder="6.25" />
        </Field>
        <Field label="Ligne">
          <NumInput value={item.ligne} onChange={(v) => onChange({ ...item, ligne: v })} placeholder="5.5" />
        </Field>
        <Field label="Volat.">
          <NumInput value={item.volatilite} onChange={(v) => onChange({ ...item, volatilite: v })} placeholder="opt." />
        </Field>
        <Field label="Cote">
          <NumInput value={item.cote} onChange={(v) => onChange({ ...item, cote: v })} placeholder="1.63" />
        </Field>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.dim }}>
          Prob. Poisson : {(probUsed * 100).toFixed(0)}%
          {edge !== null && (
            <span style={{ color: edge >= 0 ? C.solide : C.fragile, marginLeft: 8, fontWeight: 700 }}>
              edge {edge >= 0 ? "+" : ""}{edge.toFixed(1)} pts
            </span>
          )}
        </div>
        <button
          onClick={() => onAddBet({ category: "individuel", label: `${item.nom || "Équipe"} — ${sens} ${l.toFixed(1)} corners individuels`, cote: item.cote, probUsed, edge, verdict })}
          style={{ background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
        >
          <Plus size={13} /> Suivre
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   COMPARATEUR TAB
--------------------------------------------------------------- */
/* Stats sur les confrontations directes (total corners entre CES deux équipes précises,
   distinct des stats saison de chaque équipe contre tout le championnat).
   Une moyenne plate traiterait un match d'il y a 3 ans (effectif/entraîneur différents)
   comme celui du mois dernier — on calcule donc aussi une version pondérée EWMA qui
   privilégie les confrontations récentes, comme pour la forme des équipes. */
function computeH2hStats(matches, alpha = 0.25) {
  const valid = matches.filter((m) => m.obtenusA !== "" && m.obtenusB !== "");
  if (!valid.length) return null;
  const n = valid.length;
  const aVals = valid.map((m) => num(m.obtenusA));
  const bVals = valid.map((m) => num(m.obtenusB));
  const totals = valid.map((m) => num(m.obtenusA) + num(m.obtenusB));

  const mean = (arr) => arr.reduce((s, t) => s + t, 0) / arr.length;
  const std = (arr, m) => Math.sqrt(arr.reduce((s, t) => s + (t - m) ** 2, 0) / arr.length);
  const ewmaOf = (arr) => {
    const chrono = [...arr].reverse(); // liste = plus récent en premier, on inverse pour l'EWMA
    let e = null;
    chrono.forEach((t) => (e = e === null ? t : alpha * t + (1 - alpha) * e));
    return e;
  };

  const moyenneTotal = mean(totals);
  const moyenneA = mean(aVals);
  const moyenneB = mean(bVals);
  const seuils = [7.5, 8.5, 9.5, 10.5];
  const overRates = {};
  seuils.forEach((s) => (overRates[s] = totals.filter((t) => t > s).length / n));

  return {
    n,
    moyenneTotal,
    moyennePondereeTotal: ewmaOf(totals),
    volatiliteTotal: std(totals, moyenneTotal),
    overRates,
    moyenneA,
    moyennePondereeA: ewmaOf(aVals),
    volatiliteA: std(aVals, moyenneA),
    moyenneB,
    moyennePondereeB: ewmaOf(bVals),
    volatiliteB: std(bVals, moyenneB),
  };
}

function RawExtractH2h({ teamAName, teamBName, onImport }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const run = () => {
    if (!teamAName || !teamAName.trim() || !teamBName || !teamBName.trim()) {
      setError("Renseigne d'abord les deux noms d'équipe ci-dessus (pour identifier les bonnes lignes).");
      return;
    }
    const { results, skipped } = parseRawH2hBlock(text, teamAName, teamBName);
    if (!results.length) {
      setError(`Aucune confrontation reconnue entre "${teamAName}" et "${teamBName}" — vérifie que les noms correspondent exactement à ceux du tableau collé.`);
      return;
    }
    onImport(results);
    setInfo(`${results.length} confrontation${results.length > 1 ? "s" : ""} importée${results.length > 1 ? "s" : ""}${skipped.length ? ` · ${skipped.length} ligne(s) ignorée(s) (autres adversaires)` : ""}. Vérifie le résultat avant de t'y fier.`);
    setError("");
    setText("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ fontSize: 10.5, color: C.dim, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>
        Extraction auto
      </button>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 8, width: "100%" }}>
      <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.4 }}>
        Colle le tableau "TàT" / confrontations directes copié depuis MakeYourStats/Flashscore, tel quel. L'app repère
        les matchs entre <b style={{ color: C.text }}>{teamAName || "(A)"}</b> et <b style={{ color: C.text }}>{teamBName || "(B)"}</b> et
        lit la colonne corners automatiquement, peu importe qui jouait à domicile ce jour-là.
        <b style={{ color: C.fragile }}> Vérifie toujours le résultat.</b>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Colle ici tout le tableau copié..." rows={8} style={{ ...inputStyle, resize: "vertical", fontSize: 12 }} />
      {error && <div style={{ fontSize: 11, color: C.fragile }}>{error}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={run} style={{ flex: 1, background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 6, padding: "6px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          Extraire
        </button>
        <button onClick={() => { setOpen(false); setError(""); }} style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 10px", color: C.dim, fontSize: 12, cursor: "pointer" }}>
          Annuler
        </button>
      </div>
      {info && <div style={{ fontSize: 11, color: C.jouable }}>{info}</div>}
    </div>
  );
}

function H2hSection({ h2h, setH2h, teamAName, teamBName, seasonProj }) {
  const stats = computeH2hStats(h2h);
  const update = (id, next) => setH2h(h2h.map((m) => (m.id === id ? next : m)));
  const remove = (id) => setH2h(h2h.filter((m) => m.id !== id));
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState("");

  const importBulk = () => {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      const nums = line.match(/-?\d+(\.\d+)?/g);
      if (!nums || nums.length < 2) continue;
      parsed.push({ id: uid(), obtenusA: nums[0], obtenusB: nums[1] });
    }
    if (!parsed.length) {
      setBulkError(`Aucune paire reconnue — un match par ligne, corners ${teamAName || "équipe A"} puis ${teamBName || "équipe B"}, ex : 5 4`);
      return;
    }
    setH2h([...parsed, ...h2h]);
    setBulkText("");
    setBulkError("");
    setBulkOpen(false);
  };

  const ecart = stats && seasonProj ? Math.abs(stats.moyennePondereeTotal - seasonProj) : null;
  const ecartNotable = ecart !== null && ecart >= 1.5 && stats.n >= 3;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionTitle sub="corners de chaque équipe, l'une contre l'autre">
        Confrontations directes
      </SectionTitle>
      <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.4 }}>
        Distinct des stats saison ci-dessus : deux équipes peuvent s'annuler mutuellement (jeu fermé) alors que chacune
        est ouverte contre le reste du championnat — ou l'inverse. Alimente aussi les corners individuels ci-dessous.
        <br />
        <span style={{ color: C.faint }}>
          ⚠️ Une vieille confrontation peut venir d'un effectif ou d'un entraîneur qui n'existe plus — la moyenne
          pondérée privilégie les matchs récents pour limiter ce biais, mais reste prudent si tes confrontations
          s'étalent sur plusieurs saisons.
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
        {!bulkOpen ? (
          <button onClick={() => setBulkOpen(true)} style={{ fontSize: 10.5, color: C.dim, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>
            Coller en vrac
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
            <div style={{ fontSize: 10.5, color: C.faint }}>
              Un match par ligne (plus récent en haut) : corners {teamAName || "équipe A"} puis {teamBName || "équipe B"}, ex : 5 4
            </div>
            <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={"5 4\n3 6\n4 4\n..."} rows={4} style={{ ...inputStyle, resize: "vertical", fontSize: 13 }} />
            {bulkError && <div style={{ fontSize: 11, color: C.fragile }}>{bulkError}</div>}
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={importBulk} style={{ flex: 1, background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 6, padding: "6px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Importer</button>
              <button onClick={() => setBulkOpen(false)} style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 10px", color: C.dim, fontSize: 12, cursor: "pointer" }}>Annuler</button>
            </div>
          </div>
        )}
        <RawExtractH2h teamAName={teamAName} teamBName={teamBName} onImport={(parsed) => setH2h([...parsed, ...h2h])} />
      </div>

      {h2h.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6, fontSize: 10, color: C.faint, fontFamily: FONT_MONO, paddingLeft: 20 }}>
            <span style={{ flex: 1, color: C.teamA }}>{teamAName || "Équipe A"}</span>
            <span style={{ flex: 1, color: C.teamB }}>{teamBName || "Équipe B"}</span>
          </div>
          {h2h.map((m, i) => (
            <div key={m.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: C.faint, width: 14, fontFamily: FONT_MONO }}>{i + 1}</span>
              <NumInput value={m.obtenusA} onChange={(v) => update(m.id, { ...m, obtenusA: v })} placeholder="corners" accent={C.teamA} />
              <NumInput value={m.obtenusB} onChange={(v) => update(m.id, { ...m, obtenusB: v })} placeholder="corners" accent={C.teamB} />
              <IconBtn onClick={() => remove(m.id)} color={C.faint} title="Supprimer"><Trash2 size={13} /></IconBtn>
            </div>
          ))}
        </div>
      )}
      <button onClick={() => setH2h([{ id: uid(), obtenusA: "", obtenusB: "" }, ...h2h])} style={{ ...addRowStyle(), marginTop: 0 }}>
        <Plus size={13} /> Ajouter un match
      </button>

      {stats && (
        <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim, display: "flex", flexDirection: "column", gap: 4 }}>
          <div>Calculé sur <b style={{ color: C.text }}>{stats.n}</b> confrontation{stats.n > 1 ? "s" : ""}</div>
          <div>
            total brute <b style={{ color: C.text }}>{stats.moyenneTotal.toFixed(2)}</b> · pondérée récente{" "}
            <b style={{ color: C.text }}>{stats.moyennePondereeTotal.toFixed(2)}</b>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            volatilité totale <b style={{ color: C.text }}>±{stats.volatiliteTotal.toFixed(2)}</b>
            <VolBadge vol={stats.volatiliteTotal} volSource="historique" />
          </div>
          <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5, display: "flex", gap: 14 }}>
            <span style={{ color: C.teamA }}>{teamAName || "A"} : {stats.moyenneA.toFixed(2)} (pond. {stats.moyennePondereeA.toFixed(2)})</span>
            <span style={{ color: C.teamB }}>{teamBName || "B"} : {stats.moyenneB.toFixed(2)} (pond. {stats.moyennePondereeB.toFixed(2)})</span>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {[7.5, 8.5, 9.5, 10.5].map((s) => (
              <span key={s}>Over {s} : <b style={{ color: C.text }}>{(stats.overRates[s] * 100).toFixed(0)}%</b></span>
            ))}
          </div>
        </div>
      )}

      {stats && seasonProj && (
        <div
          style={{
            background: ecartNotable ? C.jouable + "18" : C.bg,
            border: `1px solid ${ecartNotable ? C.jouable + "55" : C.line}`,
            borderRadius: 8,
            padding: 10,
            fontSize: 11.5,
            color: ecartNotable ? C.jouable : C.dim,
            lineHeight: 1.5,
          }}
        >
          Projection saison : <b>{seasonProj.toFixed(2)}</b> vs confrontations directes pondérées : <b>{stats.moyennePondereeTotal.toFixed(2)}</b> <span style={{ color: C.faint }}>(brute : {stats.moyenneTotal.toFixed(2)})</span>
          {ecartNotable ? (
            <> — écart notable (±{ecart.toFixed(1)}). Ce match précis a une dynamique différente de ce que suggèrent les stats saison seules ; avec {stats.n} confrontations, ça mérite d'être pris au sérieux.</>
          ) : (
            <> — cohérent, pas de signal contradictoire.</>
          )}
        </div>
      )}
    </div>
  );
}

function ComparateurTab({ teamA, setTeamA, teamB, setTeamB, lignes, setLignes, individuels, setIndividuels, h2h, setH2h, onAddBet }) {
  // même filtre compétition que dans le profil solo — appliqué ici aussi pour que le
  // duel reste cohérent avec ce que l'utilisateur a choisi de regarder par équipe
  const filterMatches = (team) => {
    const excludedLigues = team.excludedLigues || [];
    if (!excludedLigues.length) return team;
    return { ...team, matches: team.matches.filter((m) => !excludedLigues.includes(m.ligue || "(non identifiée)")) };
  };
  const effA = pickVenueStats(filterMatches(teamA), "D");
  const effB = pickVenueStats(filterMatches(teamB), "E");
  // stats tous lieux confondus (pas de filtre domicile/extérieur) — pour le panneau
  // "Buts (match complet) — tous lieux confondus", en complément du panneau existant
  // qui croise domicile (équipe A) / extérieur (équipe B)
  const statsATotal = computeHistoryStats(filterMatches(teamA).matches, 0.25, !!teamA.useAdvanced) || {};
  const statsBTotal = computeHistoryStats(filterMatches(teamB).matches, 0.25, !!teamB.useAdvanced) || {};

  const proj = projection(num(effA.obtenus), num(effB.concedes), num(effB.obtenus), num(effA.concedes));
  const matchLabel = `${teamA.nom || "Équipe A"} vs ${teamB.nom || "Équipe B"}`;

  // synthèse "quelle équipe + quelle mi-temps" — répond directement à la question posée :
  // pas seulement les deux panneaux séparés, mais UNE recommandation qui compare les deux
  const recMT1 = evaluateMiTempsHandicap(effA.mt1Series, effB.mt1Series);
  const recMT2 = evaluateMiTempsHandicap(effA.mt2Series, effB.mt2Series);

  // volatilité saison = combinaison des deux écarts-types (variances indépendantes)
  const volA = num(effA.volatilite);
  const volB = num(effB.volatilite);
  const volSaisonTotal = volA || volB ? Math.sqrt(volA * volA + volB * volB) : null;
  const h2hStats = computeH2hStats(h2h);
  const h2hReady = h2hStats && h2hStats.n >= 3;

  /* Prédiction expérimentale : utilise la corrélation historique propre à chaque
     équipe (total corners de ses matchs vs total tirs/att. dangereuses de ces mêmes
     matchs) pour convertir une projection de tirs/attaques dangereuses en estimation
     de corners. Entièrement optionnel — absent si les données ne sont pas renseignées. */
  const buildPrediction = (corrA, corrB, seriesA, seriesB) => {
    if (!seriesA || !seriesB || !corrA || !corrB) return null;
    if (corrA.n < 4 || corrB.n < 4) return null;
    const projStat = projection(seriesA.moyObtenus, seriesB.moyConcedes, seriesB.moyObtenus, seriesA.moyConcedes);
    const predA = corrA.intercept + corrA.slope * projStat.total;
    const predB = corrB.intercept + corrB.slope * projStat.total;
    const predicted = (predA + predB) / 2;
    const minAbsR = Math.min(Math.abs(corrA.r), Math.abs(corrB.r));
    const minN = Math.min(corrA.n, corrB.n);
    let verdict = "Fragile";
    if (minAbsR >= 0.5 && minN >= 6) verdict = "Solide";
    else if (minAbsR >= 0.3 && minN >= 4) verdict = "Jouable";
    return { predicted, projStat: projStat.total, rA: corrA.r, nA: corrA.n, rB: corrB.r, nB: corrB.n, verdict };
  };

  const statsAFull = teamA.useAdvanced ? computeHistoryStats(teamA.matches, 0.25, true) : null;
  const statsBFull = teamB.useAdvanced ? computeHistoryStats(teamB.matches, 0.25, true) : null;
  const predTirs = statsAFull && statsBFull ? buildPrediction(statsAFull.corrTirs, statsBFull.corrTirs, statsAFull.tirsSeries, statsBFull.tirsSeries) : null;
  const predAttDang = statsAFull && statsBFull ? buildPrediction(statsAFull.corrAttDang, statsBFull.corrAttDang, statsAFull.attDangSeries, statsBFull.attDangSeries) : null;

  /* Trois cas distincts, affichés côte à côte — c'est toi qui choisis lequel utiliser
     pour le calcul, l'app ne tranche pas à ta place. "Saison" reste le cas par défaut. */
  const cases = {
    saison: {
      label: "Saison actuelle",
      total: proj.total,
      volTotal: volSaisonTotal,
      projA: proj.projA,
      projB: proj.projB,
      volA: effA.volatilite || null,
      volB: effB.volatilite || null,
      available: true,
    },
    h2h: h2hReady
      ? {
          label: "Confrontations directes",
          total: h2hStats.moyennePondereeTotal,
          volTotal: h2hStats.volatiliteTotal,
          projA: h2hStats.moyennePondereeA,
          projB: h2hStats.moyennePondereeB,
          volA: h2hStats.volatiliteA,
          volB: h2hStats.volatiliteB,
          available: true,
        }
      : { label: "Confrontations directes", available: false },
    combine: h2hReady
      ? (() => {
          // pondération par taille d'échantillon (plus de matchs = plus de poids),
          // pas un ratio fixe arbitraire — calculée séparément par équipe et pour le total
          const wavg = (seasonVal, seasonN, h2hVal, h2hN) => {
            const total = (seasonN || 0) + (h2hN || 0);
            if (!total) return (seasonVal + h2hVal) / 2;
            return (seasonVal * seasonN + h2hVal * h2hN) / total;
          };
          const nSeasonTotal = (effA.n || 0) + (effB.n || 0);
          return {
            label: "Combiné",
            total: wavg(proj.total, nSeasonTotal, h2hStats.moyennePondereeTotal, h2hStats.n * 2),
            volTotal: wavg(volSaisonTotal || h2hStats.volatiliteTotal, nSeasonTotal, h2hStats.volatiliteTotal, h2hStats.n * 2),
            projA: wavg(proj.projA, effA.n, h2hStats.moyennePondereeA, h2hStats.n),
            projB: wavg(proj.projB, effB.n, h2hStats.moyennePondereeB, h2hStats.n),
            volA: wavg(effA.volatilite || h2hStats.volatiliteA, effA.n, h2hStats.volatiliteA, h2hStats.n),
            volB: wavg(effB.volatilite || h2hStats.volatiliteB, effB.n, h2hStats.volatiliteB, h2hStats.n),
            nSeason: nSeasonTotal,
            nH2h: h2hStats.n * 2,
            available: true,
          };
        })()
      : { label: "Combiné", available: false },
    viaTirs: predTirs
      ? {
          label: "Via tirs",
          total: predTirs.predicted,
          volTotal: null,
          projA: predTirs.predicted * (proj.total ? proj.projA / proj.total : 0.5),
          projB: predTirs.predicted * (proj.total ? proj.projB / proj.total : 0.5),
          volA: null,
          volB: null,
          corrInfo: predTirs,
          available: true,
        }
      : { label: "Via tirs", available: false },
    viaAttDang: predAttDang
      ? {
          label: "Via att. dangereuses",
          total: predAttDang.predicted,
          volTotal: null,
          projA: predAttDang.predicted * (proj.total ? proj.projA / proj.total : 0.5),
          projB: predAttDang.predicted * (proj.total ? proj.projB / proj.total : 0.5),
          volA: null,
          volB: null,
          corrInfo: predAttDang,
          available: true,
        }
      : { label: "Via att. dangereuses", available: false },
  };

  const [source, setSource] = useState("saison");
  const active = cases[source] && cases[source].available ? cases[source] : cases.saison;
  const fallbackVolTotal = active.volTotal;

  const addIndividuelFromTeam = (team, eff, side) => {
    const moyenne = active[side === "A" ? "projA" : "projB"];
    const vol = active[side === "A" ? "volA" : "volB"];
    // le détail obtenu/concédé n'a de sens que pour le cas "saison" (moyenne = vraie
    // moyenne croisée entre 2 sources) ; pour H2H/combiné c'est déjà une valeur directe
    const sourceObtenus = source === "saison" ? (side === "A" ? effA.obtenus : effB.obtenus) : null;
    const sourceConcedes = source === "saison" ? (side === "A" ? effB.concedes : effA.concedes) : null;
    setIndividuels([
      ...individuels,
      {
        id: uid(),
        nom: team.nom,
        moyenne: moyenne ? moyenne.toFixed(2) : eff.obtenus ? String(eff.obtenus) : "",
        ligne: "",
        volatilite: vol ? String(vol.toFixed(2)) : "",
        cote: "",
        sourceObtenus,
        sourceConcedes,
        sourceCase: active.label,
      },
    ]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", gap: 10 }}>
        <Flag size={16} color={C.dim} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>
          <b style={{ color: C.text }}>Règle marge / volatilité</b> — ratio ≥ 1 : <span style={{ color: C.solide, fontWeight: 700 }}>Solide</span> · 0.5–1 : <span style={{ color: C.jouable, fontWeight: 700 }}>Jouable</span> · &lt; 0.5 : <span style={{ color: C.fragile, fontWeight: 700 }}>Fragile</span>.
        </div>
      </div>

      <section>
        <SectionTitle>Profils d'équipe</SectionTitle>
        <div className="grid grid-cols-1 gap-3" style={{ marginBottom: 10 }}>
          <TeamProfileForm team={teamA} setTeam={setTeamA} color={C.teamA} label="Équipe A · domicile" />
          {effA.n > 0 && (
            <div style={{ fontSize: 10.5, color: C.faint, fontFamily: FONT_MONO, marginTop: -6 }}>
              Stats utilisées : <b style={{ color: C.teamA }}>{effA.source}</b> ({effA.n} match{effA.n > 1 ? "s" : ""})
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <ArrowRightLeft size={16} color={C.faint} />
          </div>
          <TeamProfileForm team={teamB} setTeam={setTeamB} color={C.teamB} label="Équipe B · extérieur" />
          {effB.n > 0 && (
            <div style={{ fontSize: 10.5, color: C.faint, fontFamily: FONT_MONO, marginTop: -6 }}>
              Stats utilisées : <b style={{ color: C.teamB }}>{effB.source}</b> ({effB.n} match{effB.n > 1 ? "s" : ""})
            </div>
          )}
        </div>
      </section>

      <LectureCroisee teamA={effA} teamB={effB} proj={proj} />

      <EloPanel teamAName={teamA.nom} teamBName={teamB.nom} />

      <SecondaryStatPanel
        label="Tirs"
        unit="tirs"
        seriesA={effA.tirsSeries}
        seriesB={effB.tirsSeries}
        sourceA={effA.source}
        sourceB={effB.source}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
      />

      <SecondaryStatPanel
        label="Attaques dangereuses"
        unit="att. dangereuses"
        seriesA={effA.attDangSeries}
        seriesB={effB.attDangSeries}
        sourceA={effA.source}
        sourceB={effB.source}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
      />

      <MiTempsRecommendation
        recMT1={recMT1}
        recMT2={recMT2}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
        matchLabel={matchLabel}
        onAddBet={onAddBet}
      />

      <SecondaryStatPanel
        label="Corners 1ère mi-temps"
        unit="corners"
        seriesA={effA.mt1Series}
        seriesB={effB.mt1Series}
        sourceA={effA.source}
        sourceB={effB.source}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
        showHandicapSignal
      />

      <SecondaryStatPanel
        label="Corners 2ème mi-temps"
        unit="corners"
        seriesA={effA.mt2Series}
        seriesB={effB.mt2Series}
        sourceA={effA.source}
        sourceB={effB.source}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
        showHandicapSignal
      />

      <SecondaryStatPanel
        label="Buts (match complet)"
        unit="buts"
        seriesA={effA.butsSeries}
        seriesB={effB.butsSeries}
        sourceA={effA.source}
        sourceB={effB.source}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
        showRatioVerdict
        showFormLabels
      />

      <SecondaryStatPanel
        label="Buts (match complet) — tous lieux confondus"
        unit="buts"
        seriesA={statsATotal.butsSeries}
        seriesB={statsBTotal.butsSeries}
        sourceA="tous lieux confondus"
        sourceB="tous lieux confondus"
        teamAName={teamA.nom}
        teamBName={teamB.nom}
        showRatioVerdict
        showFormLabels
      />

      <H2hSection h2h={h2h} setH2h={setH2h} teamAName={teamA.nom} teamBName={teamB.nom} seasonProj={proj.total} />

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <SectionTitle>Quel cas utiliser pour le calcul ?</SectionTitle>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["saison", "h2h", "combine", "viaTirs", "viaAttDang"].map((key) => {
            const c = cases[key];
            const isActive = source === key;
            const disabled = !c.available;
            return (
              <button
                key={key}
                onClick={() => !disabled && setSource(key)}
                disabled={disabled}
                style={{
                  flex: "1 1 30%",
                  padding: "8px 4px",
                  borderRadius: 8,
                  border: `1px solid ${isActive ? C.solide : C.line}`,
                  background: isActive ? C.solide + "22" : "transparent",
                  color: disabled ? C.faint : isActive ? C.solide : C.dim,
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim }}>
          {["saison", "h2h", "combine", "viaTirs", "viaAttDang"].map((key) => {
            const c = cases[key];
            const isPred = key === "viaTirs" || key === "viaAttDang";
            if (!c.available) {
              return (
                <div key={key} style={{ color: C.faint }}>
                  {c.label} : indisponible {key === "h2h" || key === "combine" ? "(besoin d'au moins 3 confrontations directes)" : isPred ? "(active tirs/att. dangereuses sur les 2 équipes, ≥4 matchs couplés)" : ""}
                </div>
              );
            }
            return (
              <div key={key}>
                <div style={{ display: "flex", justifyContent: "space-between", color: source === key ? C.text : C.dim, fontWeight: source === key ? 700 : 400 }}>
                  <span>{c.label} {isPred && <Pill color={verdictColor(c.corrInfo.verdict)}>{c.corrInfo.verdict}</Pill>}</span>
                  <span>
                    {c.total.toFixed(2)} corners {c.volTotal ? `· ±${c.volTotal.toFixed(2)}` : ""}
                  </span>
                </div>
                {key === "combine" && (
                  <div style={{ fontSize: 10, color: C.faint, textAlign: "right" }}>
                    pondéré : saison {c.nSeason} obs. / H2H {c.nH2h} obs.
                  </div>
                )}
                {isPred && (
                  <div style={{ fontSize: 10, color: C.faint, textAlign: "right" }}>
                    r {teamA.nom || "A"}={c.corrInfo.rA.toFixed(2)} (n={c.corrInfo.nA}) · r {teamB.nom || "B"}={c.corrInfo.rB.toFixed(2)} (n={c.corrInfo.nB}) · répartition par équipe estimée proportionnellement à la saison
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: C.faint, lineHeight: 1.4 }}>
          Le cas sélectionné alimente le calcul du total ci-dessous et le préremplissage des corners individuels. Tu
          gardes la main sur le choix — l'app ne tranche pas à ta place.
        </div>
      </div>

      <section>
        <SectionTitle sub={`cas actif : ${active.label}`}>Corners totaux du match</SectionTitle>
        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            padding: 12,
            marginBottom: 10,
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: C.dim,
            lineHeight: 1.6,
          }}
        >
          Projection ({active.label}) : <span style={{ color: C.teamA }}>{active.projA.toFixed(2)}</span> +{" "}
          <span style={{ color: C.teamB }}>{active.projB.toFixed(2)}</span> ={" "}
          <b style={{ color: C.text }}>{active.total.toFixed(2)} corners projetés</b>
          {fallbackVolTotal && (
            <>
              <br />
              volatilité utilisée : <b style={{ color: C.text }}>±{fallbackVolTotal.toFixed(2)}</b>
            </>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {lignes.map((l) => (
            <LigneRow
              key={l.id}
              ligne={l}
              moyenne={active.total || num(l.moyenneManuelle)}
              fallbackVol={fallbackVolTotal}
              matchLabel={matchLabel}
              onChange={(next) => setLignes(lignes.map((x) => (x.id === l.id ? next : x)))}
              onRemove={() => setLignes(lignes.filter((x) => x.id !== l.id))}
              onAddBet={onAddBet}
            />
          ))}
        </div>
        <button onClick={() => setLignes([...lignes, { id: uid(), valeur: "", pourcentage: "", cote: "", volatilite: "" }])} style={addRowStyle()}>
          <Plus size={14} /> Ajouter une ligne
        </button>
      </section>

      <section>
        <SectionTitle>Corners individuels</SectionTitle>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <button
            onClick={() => addIndividuelFromTeam(teamA, effA, "A")}
            style={{ ...addRowStyle(), marginTop: 0, borderColor: C.teamA + "55", color: C.teamA }}
          >
            <Plus size={13} /> {teamA.nom || "Équipe A"}
          </button>
          <button
            onClick={() => addIndividuelFromTeam(teamB, effB, "B")}
            style={{ ...addRowStyle(), marginTop: 0, borderColor: C.teamB + "55", color: C.teamB }}
          >
            <Plus size={13} /> {teamB.nom || "Équipe B"}
          </button>
        </div>
        <div style={{ fontSize: 10, color: C.faint, fontFamily: FONT_MONO, marginBottom: 10, lineHeight: 1.4 }}>
          Moyenne préremplie selon le cas sélectionné ci-dessus (<b style={{ color: C.text }}>{active.label}</b>) : ajustée
          avec la fragilité défensive de l'adversaire, pas juste la moyenne brute de l'équipe seule.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {individuels.map((it) => (
            <IndividuelRow
              key={it.id}
              item={it}
              onChange={(next) => setIndividuels(individuels.map((x) => (x.id === it.id ? next : x)))}
              onRemove={() => setIndividuels(individuels.filter((x) => x.id !== it.id))}
              onAddBet={onAddBet}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------
   HISTORIQUE TAB
--------------------------------------------------------------- */
function QuickAddForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [cote, setCote] = useState("");
  const [result, setResult] = useState("won");
  const submit = () => {
    if (!label.trim()) return;
    onAdd({ category: "manuel", label: label.trim(), cote, probUsed: null, edge: null, result });
    setLabel(""); setCote(""); setResult("won"); setOpen(false);
  };
  if (!open) {
    return <button onClick={() => setOpen(true)} style={addRowStyle()}><Plus size={14} /> Ajouter un pari déjà joué</button>;
  }
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Description du pari">
        <TextInput value={label} onChange={setLabel} placeholder="ex : Shenzhen Over 4.5 corners" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Cote (opt.)"><NumInput value={cote} onChange={setCote} placeholder="1.63" /></Field>
        <Field label="Résultat">
          <select value={result} onChange={(e) => setResult(e.target.value)} style={{ ...inputStyle, fontFamily: FONT_BODY }}>
            <option value="won">Gagné</option>
            <option value="lost">Perdu</option>
            <option value="push">Push</option>
            <option value="pending">En attente</option>
          </select>
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} style={{ flex: 1, background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 8, padding: "8px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Ajouter</button>
        <button onClick={() => setOpen(false)} style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 14px", color: C.dim, fontSize: 13, cursor: "pointer" }}>Annuler</button>
      </div>
    </div>
  );
}
function ResultBtn({ active, color, onClick, children }) {
  return (
    <button onClick={onClick} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "6px 4px", borderRadius: 8, border: `1px solid ${active ? color : C.line}`, background: active ? color + "22" : "transparent", color: active ? color : C.faint, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
      {children}
    </button>
  );
}
function HistoriqueTab({ bets, setResult, removeBet, addManualBet, updateCote }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <QuickAddForm onAdd={addManualBet} />
      {!bets.length && <EmptyState title="Aucun pari suivi" text="Ajoute un pari terminé ci-dessus, ou utilise le bouton « Suivre » depuis l'onglet Comparateur." />}
      {bets.map((b) => (
        <div key={b.id} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>{b.label}</div>
            <IconBtn onClick={() => removeBet(b.id)} color={C.faint} title="Supprimer"><Trash2 size={13} /></IconBtn>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim, flexWrap: "wrap" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              cote
              <input
                type="number"
                inputMode="decimal"
                value={b.cote || ""}
                placeholder="1.85"
                onChange={(e) => updateCote(b.id, e.target.value)}
                style={{ width: 52, background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 6, padding: "3px 6px", color: C.text, fontFamily: FONT_MONO, fontSize: 11.5, outline: "none" }}
              />
            </span>
            {b.probUsed !== null && <span>prob. {(b.probUsed * 100).toFixed(0)}%</span>}
            {b.edge !== null && b.edge !== undefined && <span style={{ color: b.edge >= 0 ? C.solide : C.fragile, fontWeight: 700 }}>edge {b.edge >= 0 ? "+" : ""}{b.edge.toFixed(1)}</span>}
            <span>{new Date(b.createdAt).toLocaleDateString("fr-FR")}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <ResultBtn active={b.result === "won"} color={C.solide} onClick={() => setResult(b.id, "won")}><Check size={13} /> Gagné</ResultBtn>
            <ResultBtn active={b.result === "lost"} color={C.fragile} onClick={() => setResult(b.id, "lost")}><X size={13} /> Perdu</ResultBtn>
            <ResultBtn active={b.result === "push"} color={C.jouable} onClick={() => setResult(b.id, "push")}><Minus size={13} /> Push</ResultBtn>
            <ResultBtn active={b.result === "pending"} color={C.dim} onClick={() => setResult(b.id, "pending")}><RotateCcw size={13} /></ResultBtn>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   BILAN TAB
--------------------------------------------------------------- */
function StatCard({ label, value, sub, valueColor }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 11, color: C.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, color: valueColor || C.text }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: 2, fontFamily: FONT_MONO }}>{sub}</div>}
    </div>
  );
}
function BilanTab({ stats }) {
  if (!stats.total) return <EmptyState title="Pas encore de bilan" text="Suis quelques paris pour voir ton taux de réussite et ton P/L ici." />;
  const plColor = stats.cumul >= 0 ? C.solide : C.fragile;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Paris suivis" value={stats.total} />
        <StatCard label="Taux de réussite" value={stats.winRate !== null ? `${stats.winRate.toFixed(0)}%` : "—"} sub={`${stats.won}G / ${stats.lost}P${stats.push ? ` / ${stats.push} push` : ""}`} />
        <StatCard label="Edge moyen" value={`${stats.avgEdge >= 0 ? "+" : ""}${stats.avgEdge.toFixed(1)} pts`} />
        <StatCard label="P/L cumulé" value={`${stats.cumul >= 0 ? "+" : ""}${stats.cumul.toFixed(2)}u`} valueColor={plColor} />
      </div>
      {stats.series.length > 1 && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12 }}>
          <SectionTitle>Évolution du P/L</SectionTitle>
          <div style={{ width: "100%", height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={stats.series} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid stroke={C.line} strokeDasharray="3 3" />
                <XAxis dataKey="n" stroke={C.faint} fontSize={10} />
                <YAxis stroke={C.faint} fontSize={10} />
                <Tooltip contentStyle={{ background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.dim }} />
                <Line type="monotone" dataKey="pl" stroke={plColor} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {stats.categories.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionTitle sub="pour repérer un vrai edge récurrent vs du bruit sur un seul match">Par marché</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {stats.categories.map((c) => (
              <div key={c.category} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                <span style={{ color: C.text }}>{c.label}</span>
                <span style={{ fontFamily: FONT_MONO, color: C.dim, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{c.won}G / {c.lost}P{c.push ? ` / ${c.push} push` : ""}</span>
                  <b style={{ color: c.winRate === null ? C.faint : c.winRate >= 50 ? C.solide : C.fragile, minWidth: 34, textAlign: "right" }}>
                    {c.winRate !== null ? `${c.winRate.toFixed(0)}%` : "—"}
                  </b>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {stats.verdicts && stats.verdicts.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionTitle sub="le ratio marge/volatilité est-il un vrai indicateur de qualité, ou juste du bruit ?">Par verdict</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {stats.verdicts.map((v) => (
              <div key={v.verdict} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                <Pill color={verdictColor(v.verdict)}>{v.verdict}</Pill>
                <span style={{ fontFamily: FONT_MONO, color: C.dim, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{v.won}G / {v.lost}P{v.push ? ` / ${v.push} push` : ""}</span>
                  <b style={{ color: v.winRate === null ? C.faint : v.winRate >= 50 ? C.solide : C.fragile, minWidth: 34, textAlign: "right" }}>
                    {v.winRate !== null ? `${v.winRate.toFixed(0)}%` : "—"}
                  </b>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   MAIN APP
--------------------------------------------------------------- */
export default function App() {
  const [tab, setTab] = useState("comparateur");
  const [loading, setLoading] = useState(true);
  const [bets, setBets] = useState([]);
  const [saveError, setSaveError] = useState(false);

  const [teamA, setTeamA] = useState(emptyTeam());
  const [teamB, setTeamB] = useState(emptyTeam());
  const [lignes, setLignes] = useState([{ id: uid(), valeur: "8.5", pourcentage: "", cote: "", volatilite: "" }]);
  const [individuels, setIndividuels] = useState([]);
  const [h2h, setH2h] = useState([]);
  const [savedMatches, setSavedMatches] = useState([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveNameInput, setSaveNameInput] = useState("");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [storageBroken, setStorageBroken] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("arc_bets_v1", false);
        if (res && res.value) setBets(JSON.parse(res.value));
      } catch (e) {}
      try {
        const saved = await window.storage.get("arc_matches_v1", false);
        if (saved && saved.value) setSavedMatches(JSON.parse(saved.value));
      } catch (e) {}
      try {
        const draft = await window.storage.get("arc_draft_v1", false);
        if (draft && draft.value) {
          const d = JSON.parse(draft.value);
          if (d.teamA) setTeamA(d.teamA);
          if (d.teamB) setTeamB(d.teamB);
          if (d.lignes) setLignes(d.lignes);
          if (d.individuels) setIndividuels(d.individuels);
          if (d.h2h) setH2h(d.h2h);
        }
      } catch (e) {}
      setLoading(false);
      setDraftLoaded(true);
    })();
  }, []);

  const persistSavedMatches = useCallback(async (next) => {
    setSavedMatches(next);
    try {
      await window.storage.set("arc_matches_v1", JSON.stringify(next), false);
    } catch (e) {
      setStorageBroken(true);
    }
  }, []);

  const saveCurrentAsMatch = (name) => {
    const snapshot = { id: uid(), name, savedAt: new Date().toISOString(), teamA, teamB, lignes, individuels, h2h };
    persistSavedMatches([snapshot, ...savedMatches]);
  };
  const loadSavedMatch = (m) => {
    setTeamA(m.teamA || emptyTeam());
    setTeamB(m.teamB || emptyTeam());
    setLignes(m.lignes || [{ id: uid(), valeur: "8.5", pourcentage: "", cote: "", volatilite: "" }]);
    setIndividuels(m.individuels || []);
    setH2h(m.h2h || []);
  };
  const deleteSavedMatch = (id) => persistSavedMatches(savedMatches.filter((m) => m.id !== id));

  const saveDraftNow = useCallback(async () => {
    setSavingDraft(true);
    try {
      const ok = await window.storage.set("arc_draft_v1", JSON.stringify({ teamA, teamB, lignes, individuels, h2h }), false);
      if (ok) {
        setLastSaved(new Date());
        setStorageBroken(false);
      } else {
        setStorageBroken(true);
      }
    } catch (e) {
      setStorageBroken(true);
    }
    setSavingDraft(false);
  }, [teamA, teamB, lignes, individuels]);

  // sauvegarde automatique (avec léger délai) à chaque modification du travail en cours,
  // pour ne rien perdre en changeant d'application ou si la page se recharge
  useEffect(() => {
    if (!draftLoaded) return;
    const t = setTimeout(saveDraftNow, 600);
    return () => clearTimeout(t);
  }, [teamA, teamB, lignes, individuels, h2h, draftLoaded, saveDraftNow]);

  // sauvegarde immédiate (sans attendre le délai) dès que l'onglet passe en arrière-plan —
  // un téléphone peut mettre l'onglet en pause ou le recharger juste après un changement
  // d'onglet, avant que le délai de 600ms n'ait eu le temps de se déclencher
  useEffect(() => {
    if (!draftLoaded) return;
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        saveDraftNow();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handleVisibility);
    };
  }, [draftLoaded, saveDraftNow]);

  const persist = useCallback(async (next) => {
    setBets(next);
    try {
      const ok = await window.storage.set("arc_bets_v1", JSON.stringify(next), false);
      if (!ok) setSaveError(true);
    } catch (e) {
      setSaveError(true);
    }
  }, []);

  const addBet = (payload) => persist([{ id: uid(), createdAt: new Date().toISOString(), stake: 1, result: "pending", ...payload }, ...bets]);
  const setResult = (id, result) => persist(bets.map((b) => (b.id === id ? { ...b, result } : b)));
  const removeBet = (id) => persist(bets.filter((b) => b.id !== id));
  const updateCote = (id, cote) => persist(bets.map((b) => (b.id === id ? { ...b, cote } : b)));

  const stats = useMemo(() => {
    const resolved = bets.filter((b) => b.result !== "pending");
    const won = resolved.filter((b) => b.result === "won").length;
    const lost = resolved.filter((b) => b.result === "lost").length;
    const push = resolved.filter((b) => b.result === "push").length;
    const decided = won + lost;
    const winRate = decided ? (won / decided) * 100 : null;
    let cumul = 0;
    const series = [];
    [...resolved].reverse().forEach((b, i) => {
      const c = parseFloat(b.cote);
      if (b.result === "won" && c) cumul += (c - 1) * b.stake;
      else if (b.result === "lost") cumul -= b.stake;
      series.push({ n: i + 1, pl: Number(cumul.toFixed(2)) });
    });
    const withEdge = bets.filter((b) => b.edge !== null && b.edge !== undefined);
    const avgEdge = withEdge.reduce((s, b) => s + b.edge, 0) / (withEdge.length || 1);

    // taux de réussite par marché (total / individuel / mi-temps / manuel) — répond à
    // "est-ce que ce signal 1MT/2MT est un vrai edge récurrent ou du bruit ?"
    const categoryLabels = { total: "Total corners", individuel: "Corners individuels", "mi-temps": "Signal mi-temps", manuel: "Ajouté manuellement" };
    const byCategory = {};
    resolved.forEach((b) => {
      const cat = b.category || "manuel";
      if (!byCategory[cat]) byCategory[cat] = { won: 0, lost: 0, push: 0 };
      byCategory[cat][b.result === "won" ? "won" : b.result === "lost" ? "lost" : "push"]++;
    });
    const categories = Object.entries(byCategory)
      .map(([cat, c]) => {
        const dec = c.won + c.lost;
        return { category: cat, label: categoryLabels[cat] || cat, won: c.won, lost: c.lost, push: c.push, decided: dec, winRate: dec ? (c.won / dec) * 100 : null };
      })
      .sort((a, b) => b.decided - a.decided);

    // taux de réussite par verdict (Solide / Jouable / Fragile) — répond à "est-ce que
    // le ratio marge/volatilité est un vrai indicateur de qualité, ou du bruit ?"
    const verdictOrder = { Solide: 0, Jouable: 1, Fragile: 2 };
    const byVerdict = {};
    resolved.forEach((b) => {
      if (!b.verdict) return;
      if (!byVerdict[b.verdict]) byVerdict[b.verdict] = { won: 0, lost: 0, push: 0 };
      byVerdict[b.verdict][b.result === "won" ? "won" : b.result === "lost" ? "lost" : "push"]++;
    });
    const verdicts = Object.entries(byVerdict)
      .map(([verdict, c]) => {
        const dec = c.won + c.lost;
        return { verdict, won: c.won, lost: c.lost, push: c.push, decided: dec, winRate: dec ? (c.won / dec) * 100 : null };
      })
      .sort((a, b) => (verdictOrder[a.verdict] ?? 9) - (verdictOrder[b.verdict] ?? 9));

    return { won, lost, push, decided, winRate, cumul: Number(cumul.toFixed(2)), series, avgEdge, total: bets.length, categories, verdicts };
  }, [bets]);

  const tabs = [
    { id: "comparateur", label: "Comparateur", icon: Target },
    { id: "historique", label: "Historique", icon: ClipboardList },
    { id: "bilan", label: "Bilan", icon: BarChart3 },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: FONT_BODY }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-thumb { background: ${C.line}; border-radius: 3px; }
        input:focus, select:focus { border-color: ${C.solide} !important; }
        button:focus-visible, input:focus-visible { outline: 2px solid ${C.solide}; outline-offset: 1px; }
        input::placeholder { color: ${C.faint}; opacity: 0.65; font-style: italic; }
      `}</style>
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px 100px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: C.surface2, border: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="22" height="22" viewBox="0 0 22 22">
              <path d="M2 2 L2 20 L20 20" stroke={C.line} strokeWidth="1.5" fill="none" />
              <path d="M2 2 L2 12 A10 10 0 0 1 12 2 Z" fill={C.teamA} opacity="0.85" />
            </svg>
          </div>
          <div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 800, lineHeight: 1, letterSpacing: 0.5 }}>L'ARC</div>
            <div style={{ fontSize: 11, color: C.dim, letterSpacing: 0.3 }}>
              {tab === "comparateur"
                ? storageBroken
                  ? "⚠ Sauvegarde impossible"
                  : savingDraft
                  ? "Sauvegarde…"
                  : lastSaved
                  ? `Sauvegardé à ${lastSaved.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
                  : "En attente de sauvegarde"
                : "Comparateur d'équipes · corners"}
            </div>
          </div>
          {tab === "comparateur" && (
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              <button
                onClick={() => setShowLibrary((v) => !v)}
                style={{ background: showLibrary ? C.surface2 : "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", color: C.dim, fontSize: 11.5, cursor: "pointer" }}
              >
                Mes matchs {savedMatches.length > 0 && `(${savedMatches.length})`}
              </button>
              <button
                onClick={() => {
                  setSaveNameInput(`${teamA.nom || "Équipe A"} vs ${teamB.nom || "Équipe B"}`);
                  setShowSaveForm(true);
                }}
                style={{ background: C.solide + "22", border: `1px solid ${C.solide}55`, borderRadius: 8, padding: "6px 10px", color: C.solide, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
              >
                Sauvegarder
              </button>
              <button
                onClick={() => {
                  setTeamA(emptyTeam());
                  setTeamB(emptyTeam());
                  setLignes([{ id: uid(), valeur: "8.5", pourcentage: "", cote: "", volatilite: "" }]);
                  setH2h([]);
                  setIndividuels([]);
                }}
                style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", color: C.faint, fontSize: 11.5, cursor: "pointer" }}
              >
                Nouveau
              </button>
            </div>
          )}
        </div>

        {tab === "comparateur" && showSaveForm && (
          <div style={{ background: C.surface, border: `1px solid ${C.solide}55`, borderRadius: 10, padding: 10, marginBottom: 14, display: "flex", gap: 6 }}>
            <TextInput value={saveNameInput} onChange={setSaveNameInput} placeholder="Nom du match" />
            <button
              onClick={() => {
                saveCurrentAsMatch(saveNameInput.trim() || "Match sans nom");
                setShowSaveForm(false);
              }}
              style={{ background: C.solide + "22", border: `1px solid ${C.solide}55`, borderRadius: 8, padding: "6px 12px", color: C.solide, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
            >
              OK
            </button>
            <button onClick={() => setShowSaveForm(false)} style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", color: C.dim, fontSize: 12, cursor: "pointer" }}>
              Annuler
            </button>
          </div>
        )}

        {tab === "comparateur" && showLibrary && (
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {!savedMatches.length ? (
              <div style={{ fontSize: 12, color: C.faint }}>Aucun match sauvegardé pour l'instant.</div>
            ) : (
              savedMatches.map((m) => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderBottom: `1px solid ${C.line}`, paddingBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{m.name}</div>
                    <div style={{ fontSize: 10.5, color: C.faint, fontFamily: FONT_MONO }}>
                      {new Date(m.savedAt).toLocaleDateString("fr-FR")} {new Date(m.savedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => {
                        loadSavedMatch(m);
                        setShowLibrary(false);
                      }}
                      style={{ background: C.solide + "22", border: `1px solid ${C.solide}55`, borderRadius: 6, padding: "5px 10px", color: C.solide, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                    >
                      Charger
                    </button>
                    <IconBtn onClick={() => deleteSavedMatch(m.id)} color={C.fragile} title="Supprimer"><Trash2 size={13} /></IconBtn>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 18, background: C.surface, padding: 4, borderRadius: 12 }}>
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 6px", borderRadius: 9, border: "none", background: active ? C.surface2 : "transparent", color: active ? C.text : C.dim, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60, color: C.dim }}>
            <Loader2 className="animate-spin" size={22} />
          </div>
        ) : tab === "comparateur" ? (
          <ComparateurTab teamA={teamA} setTeamA={setTeamA} teamB={teamB} setTeamB={setTeamB} lignes={lignes} setLignes={setLignes} individuels={individuels} setIndividuels={setIndividuels} h2h={h2h} setH2h={setH2h} onAddBet={addBet} />
        ) : tab === "historique" ? (
          <HistoriqueTab bets={bets} setResult={setResult} removeBet={removeBet} addManualBet={addBet} updateCote={updateCote} />
        ) : (
          <BilanTab stats={stats} />
        )}

        {saveError && (
          <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: C.fragile + "18", border: `1px solid ${C.fragile}55`, color: C.fragile, fontSize: 12 }}>
            La sauvegarde des paris a échoué — vérifie ta connexion et réessaie.
          </div>
        )}
        {storageBroken && tab === "comparateur" && (
          <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: C.fragile + "18", border: `1px solid ${C.fragile}55`, color: C.fragile, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <span>
              La sauvegarde de ton travail en cours échoue vraiment (pas juste un affichage) — tes profils d'équipe ne
              seront pas conservés si tu quittes l'app maintenant.
            </span>
            <button onClick={saveDraftNow} style={{ alignSelf: "flex-start", background: "transparent", border: `1px solid ${C.fragile}`, borderRadius: 6, padding: "4px 10px", color: C.fragile, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Réessayer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

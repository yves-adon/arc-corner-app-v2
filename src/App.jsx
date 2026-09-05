import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Plus, Trash2, Check, X, Minus, RotateCcw, Target,
  ClipboardList, BarChart3, Flag, Loader2, ArrowRightLeft, Camera
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import { extractPdfText } from "./lib/pdfExtract.js";
import { fetchClubElo, computeEloMatchup } from "./lib/clubElo.js";
import { saveTeamLeagueStats, getLeagueAverage, dominantLigue } from "./lib/leagueStats.js";

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
/* ---------------------------------------------------------------
   SIGNAL / RISQUE / CONVERGENCE / RATIO CUMULÉ (RC)
   ---------------------------------------------------------------
   Ajouté suite à une analyse externe (ChatGPT) du verdict Solide/Jouable/Fragile :
   le verdict actuel (ratio marge/volatilité, cf computeVerdict ci-dessus) mélange en un
   seul chiffre la force du signal et le risque — un vrai écart peut être classé
   "Fragile" simplement parce que la volatilité est élevée, même si plusieurs autres
   indicateurs convergent. Les fonctions ci-dessous SÉPARENT ces deux axes au lieu de les
   fusionner, et ajoutent une mesure de convergence purement factuelle (% d'indicateurs
   d'accord) — PAS un score à bonus/malus inventés (+10 par-ci, -10 par-là) : un barème
   de points sans aucun backtest derrière donnerait une fausse impression de précision.
   Le verdict Solide/Jouable/Fragile existant n'est pas remplacé : ces indicateurs
   viennent en complément, affichés à côté, jamais fusionnés dans le badge existant. */

/* Force du signal (0-100) — reconversion lisible du ratio marge/volatilité déjà utilisé
   par computeVerdict. Logistique centrée sur 0.5 (le seuil "Jouable" actuel), pour éviter
   qu'un ratio brut illisible (3.4×) ou qui explose au-delà de 100 (*100 direct) serve de
   score. */
function computeSignalScore(ratio) {
  if (ratio === null || ratio === undefined || isNaN(ratio)) return null;
  return Math.round(100 / (1 + Math.exp(-3.2 * (ratio - 0.5))));
}

/* Risque (0-100, 100 = risque max) — deux sources de risque indépendantes de la marge :
   la volatilité RELATIVE (±2 sur une moyenne de 3 pèse bien plus que ±2 sur une moyenne
   de 10) et la taille d'échantillon (peu de matchs = estimation fragile même si la
   moyenne semble nette). Échantillon inconnu → score neutre (50), ni pénalisé ni
   avantagé plutôt que de deviner. */
function computeRiskScore(vol, moyenne, n) {
  if (vol === null || vol === undefined || !moyenne) return null;
  const volRel = Math.min(2, vol / Math.max(moyenne, 0.1));
  const volScore = Math.min(100, volRel * 50);
  const nScore = n === null || n === undefined ? 50 : Math.max(0, Math.min(100, 100 - (n - 3) * 11));
  return Math.round(volScore * 0.6 + nScore * 0.4);
}

/* Convergence — % d'indicateurs indépendants qui désignent le MÊME favori que la
   projection croisée principale. `checks` = liste de booléens (true = cet indicateur est
   d'accord avec le favori) déjà résolus par l'appelant, volontairement — cette fonction
   ne fait QUE compter, pour rester auditable : tu peux vérifier chaque check à la main
   plutôt que de faire confiance à une boîte noire pondérée. */
function computeConvergence(checks) {
  const valid = checks.filter((c) => c !== null && c !== undefined);
  if (!valid.length) return null;
  const aligned = valid.filter(Boolean).length;
  return { aligned, total: valid.length, pct: Math.round((aligned / valid.length) * 100) };
}

/* Ratio Cumulé (RC) — EXPÉRIMENTAL, EN OBSERVATION UNIQUEMENT (ne pèse sur aucun verdict
   pour l'instant, uniquement affiché + tracké dans le Bilan). Somme de 3 sous-ratios de
   domination pour un côté du duel :
   - ratio de projection croisée (ce que cette équipe devrait produire vs l'adversaire)
   - ratio de forme (1 + EWMA/volatilité : >1 si bonne forme, <1 si mauvaise — peut
     devenir négatif si la mauvaise forme est très marquée, ce qui est voulu : ça tire le
     RC vers le bas plutôt que de l'ignorer)
   - ratio de part (part de production de cette équipe sur le volume total du duel)
   Le but n'est PAS d'obtenir un chiffre "juste" du premier coup — c'est de générer une
   variable trackée sur chaque pari (Bilan → Par Ratio Cumulé) pour vérifier sur la durée
   si un écart RC élevé correspond réellement à un meilleur taux de réussite, avant de
   l'intégrer à quoi que ce soit d'autre. Seuils à affiner une fois qu'il y a des données. */
function computeRatioCumule({ projSide, projOther, ewma, vol, part }) {
  if (projSide === null || projSide === undefined || projOther === null || projOther === undefined) return null;
  const ratioProjection = projOther > 0 ? projSide / projOther : projSide > 0 ? 2 : 1;
  const ratioForme = vol && vol > 0 && ewma !== null && ewma !== undefined ? 1 + ewma / vol : 1;
  const ratioPart = part !== null && part !== undefined && part < 100 ? part / Math.max(100 - part, 1) : 1;
  return { ratioProjection, ratioForme, ratioPart, rc: ratioProjection + ratioForme + ratioPart };
}

/* ---------------------------------------------------------------
   PROBABILITÉ DE VICTOIRE NORMALISÉE (1X2) — EXPÉRIMENTAL
   ---------------------------------------------------------------
   Combine 3 lectures indépendantes déjà présentes ailleurs dans l'app en UNE
   probabilité normalisée par équipe (+ nul), au lieu de laisser recouper 3
   chiffres à la main :
   1) H2H — fréquence de victoire RÉELLE (comptage brut, pas une moyenne) sur
      les confrontations directes déjà saisies dans la section H2H.
   2) Buts (Poisson) — matrice de score à partir de la même projection de
      buts que le reste de l'app (projection() sur les moyennes obtenus/
      concédés), modèle Poisson indépendant standard.
   3) Forme (RC) — le Ratio Cumulé déjà calculé ailleurs (EWMA, volatilité,
      part), converti en écart A vs B. Cet axe n'a pas de notion de nul
      propre : son nul est calé sur celui du modèle Poisson, donc ce n'est
      qu'un ajustement du partage A/B, pas un 3e modèle de nul indépendant.
   Comme pour le RC, les 3 lectures restent affichées séparément — la moyenne
   pondérée n'est qu'une synthèse, jamais la seule chose montrée, pour rester
   auditable. Poids par défaut : 45% buts, 35% H2H, 20% forme, renormalisés
   si un axe manque (ex. H2H indisponible sous 3 confrontations). Aucun poids
   n'a été backtesté — comme le RC, à ajuster une fois qu'il y a des données
   de suivi (Bilan). */
function computeH2hWinProb(h2h) {
  const valid = (h2h || []).filter(
    (m) => m.butsA !== "" && m.butsA !== undefined && m.butsA !== null && m.butsB !== "" && m.butsB !== undefined && m.butsB !== null
  );
  const n = valid.length;
  if (n < 3) return null;
  const winsA = valid.filter((m) => num(m.butsA) > num(m.butsB)).length;
  const winsB = valid.filter((m) => num(m.butsB) > num(m.butsA)).length;
  const draws = n - winsA - winsB;
  return { n, pA: winsA / n, pDraw: draws / n, pB: winsB / n };
}
function computePoissonMatch(projA, projB, maxGoals = 8) {
  if (projA === null || projA === undefined || projB === null || projB === undefined || isNaN(projA) || isNaN(projB)) return null;
  const a = Math.max(projA, 0.05);
  const b = Math.max(projB, 0.05);
  let pA = 0, pDraw = 0, pB = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = poissonPmf(i, a) * poissonPmf(j, b);
      if (i > j) pA += p;
      else if (i === j) pDraw += p;
      else pB += p;
    }
  }
  const total = pA + pDraw + pB;
  if (total <= 0) return null;
  return { pA: pA / total, pDraw: pDraw / total, pB: pB / total };
}
function computeFormeProb(rcA, rcB, pDrawAnchor) {
  if (!rcA || !rcB) return null;
  const delta = rcA.rc - rcB.rc;
  const pDraw = pDrawAnchor !== null && pDrawAnchor !== undefined ? pDrawAnchor : 0.24;
  const remaining = 1 - pDraw;
  const shareA = 1 / (1 + Math.exp(-1.1 * delta));
  return { pA: shareA * remaining, pDraw, pB: (1 - shareA) * remaining };
}
function combineWinProbs({ h2h, poissonVenue, poissonGlobal, menaceVenue, menaceGlobal, formeVenue, formeGlobal }) {
  const entries = [
    { key: "h2h", data: h2h, weight: 0.3 },
    { key: "poissonVenue", data: poissonVenue, weight: 0.175 },
    { key: "poissonGlobal", data: poissonGlobal, weight: 0.175 },
    { key: "menaceVenue", data: menaceVenue, weight: 0.1 },
    { key: "menaceGlobal", data: menaceGlobal, weight: 0.1 },
    { key: "formeVenue", data: formeVenue, weight: 0.075 },
    { key: "formeGlobal", data: formeGlobal, weight: 0.075 },
  ].filter((e) => e.data);
  if (!entries.length) return null;
  const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
  const pA = entries.reduce((s, e) => s + e.data.pA * e.weight, 0) / totalWeight;
  const pDraw = entries.reduce((s, e) => s + e.data.pDraw * e.weight, 0) / totalWeight;
  const pB = entries.reduce((s, e) => s + e.data.pB * e.weight, 0) / totalWeight;
  const sum = pA + pDraw + pB || 1;
  return { pA: pA / sum, pDraw: pDraw / sum, pB: pB / sum, usedKeys: entries.map((e) => e.key) };
}

/* Une ligne = une lecture (H2H / Buts / Forme) : petite barre 3 voies + label,
   ou message "indisponible" si les données manquent — pour que la synthèse
   ci-dessus reste vérifiable au lieu d'être une boîte noire. */
function WinProbAxisRow({ label, data, teamAName, teamBName, detail }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 10.5, color: C.faint, display: "flex", justifyContent: "space-between" }}>
        <span>{label}</span>
        {detail && <span style={{ fontFamily: FONT_MONO }}>{detail}</span>}
      </div>
      {data ? (
        <ThreeWayBar
          pctVic={data.pA * 100}
          pctNul={data.pDraw * 100}
          pctDef={data.pB * 100}
          labelVic={teamAName || "Équipe A"}
          labelDef={teamBName || "Équipe B"}
          colorVic={C.teamA}
          colorDef={C.teamB}
        />
      ) : (
        <div style={{ fontSize: 10.5, color: C.faint, fontStyle: "italic" }}>indisponible</div>
      )}
    </div>
  );
}

function WinProbabilitySection({
  h2h, poissonVenue, poissonGlobal, menaceVenue, menaceGlobal, formeVenue, formeGlobal,
  combined, convAttDangA, convAttDangB, convNA, convNB, teamAName, teamBName,
}) {
  if (!combined) return null;
  const hasConv = convAttDangA !== null && convAttDangA !== undefined && convAttDangB !== null && convAttDangB !== undefined;
  const lowSample = (convNA !== null && convNA !== undefined && convNA < 6) || (convNB !== null && convNB !== undefined && convNB < 6);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionTitle sub="H2H + buts (Poisson) + attaques dangereuses + forme, dom./ext. ET tous lieux · expérimental">
        Probabilité de victoire normalisée
      </SectionTitle>
      <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 }}>
        <ThreeWayBar
          pctVic={combined.pA * 100}
          pctNul={combined.pDraw * 100}
          pctDef={combined.pB * 100}
          labelVic={teamAName || "Équipe A"}
          labelDef={teamBName || "Équipe B"}
          colorVic={C.teamA}
          colorDef={C.teamB}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
        <WinProbAxisRow label="H2H (confrontations directes)" data={h2h} teamAName={teamAName} teamBName={teamBName} detail={h2h ? `${h2h.n} confront.` : null} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
        <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.5 }}>Contexte domicile / extérieur</div>
        <WinProbAxisRow label="Buts (Poisson)" data={poissonVenue} teamAName={teamAName} teamBName={teamBName} />
        <WinProbAxisRow label="Attaques dangereuses (volume × conversion)" data={menaceVenue} teamAName={teamAName} teamBName={teamBName} />
        <WinProbAxisRow label="Forme (Ratio Cumulé)" data={formeVenue} teamAName={teamAName} teamBName={teamBName} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
        <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.5 }}>Contexte tous lieux confondus</div>
        <WinProbAxisRow label="Buts (Poisson)" data={poissonGlobal} teamAName={teamAName} teamBName={teamBName} />
        <WinProbAxisRow label="Attaques dangereuses (volume × conversion)" data={menaceGlobal} teamAName={teamAName} teamBName={teamBName} />
        <WinProbAxisRow label="Forme (Ratio Cumulé)" data={formeGlobal} teamAName={teamAName} teamBName={teamBName} />
      </div>

      {hasConv && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <div style={{ fontSize: 10.5, color: C.faint, display: "flex", justifyContent: "space-between" }}>
            <span>Buts par attaque dangereuse (conversion, régularisée, contexte le + fourni)</span>
            {lowSample && <span style={{ color: C.jouable }}>échantillon faible ({convNA}/{convNB} matchs)</span>}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 13 }}>
            <span style={{ color: C.teamA, fontWeight: 700 }}>
              {teamAName || "Équipe A"} : {convAttDangA.toFixed(3)}
            </span>
            <span style={{ color: C.teamB, fontWeight: 700 }}>
              {teamBName || "Équipe B"} : {convAttDangB.toFixed(3)}
            </span>
          </div>
          <SplitBar
            left={convAttDangA}
            right={convAttDangB}
            colorLeft={C.teamA}
            colorRight={C.teamB}
            labelLeft={`${(convAttDangA * 100).toFixed(1)}%`}
            labelRight={`${(convAttDangB * 100).toFixed(1)}%`}
          />
          <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic" }}>
            buts marqués / attaque dangereuse créée — une équipe peut générer beaucoup de danger sans concrétiser,
            d'où l'axe Attaques dangereuses qui pondère le VOLUME d'attaques par ce taux plutôt que de ne compter
            que les buts. Taux régularisé vers la moyenne commune aux 2 équipes quand l'échantillon est petit
            (moins de 6 matchs), pour chaque contexte séparément. Affiché ici : celui du contexte le mieux fourni.
          </div>
        </div>
      )}

      <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic" }}>
        Moyenne pondérée : 30% H2H, 35% buts (17.5% dom./ext. + 17.5% tous lieux), 20% attaques dangereuses (10% +
        10%), 15% forme (7.5% + 7.5%) — renormalisée selon les axes disponibles. Pas backtestée, à recouper avec les
        autres panneaux plutôt qu'à suivre seule. Le nul des axes Forme est calé sur celui du modèle Poisson du même
        contexte (pas un modèle de nul indépendant) ; les axes Buts et Attaques dangereuses ont chacun leur propre
        nul, calculé indépendamment.
      </div>
    </div>
  );
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
  // ratio SIGNÉ (contrairement à `ratio` ci-dessus qui est une valeur absolue, donc
  // toujours positive) — c'est CELUI-LÀ qu'il faut utiliser pour comparer deux équipes
  // entre elles. Sans le signe, une équipe "Bonne forme" à 1.44 et une équipe "En
  // perdition" à 1.05 semblent proches (écart 0.39) alors que l'écart réel de forme est
  // +1.44 contre -1.05, soit 2.49 — un biais qui masque complètement l'ampleur du
  // décalage entre les deux équipes.
  const signedRatio = series.ewma / vol;
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
  return { label, ratio, signedRatio, color };
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
/* Bloc d'affichage Signal / Risque / Convergence / RC — complémentaire au verdict
   Solide/Jouable/Fragile existant, jamais un remplacement. Rendu null-safe : chaque
   sous-partie ne s'affiche que si la donnée est disponible, pour ne jamais afficher un
   chiffre calculé sur des données absentes ou trompeuses. */
function SignalRiskRow({ signal, risk, convergence, rc }) {
  if (signal === null && risk === null && !convergence && !rc) return null;
  const barColor = (score, inverse) => {
    const v = inverse ? 100 - score : score;
    return v >= 66 ? C.solide : v >= 33 ? C.jouable : C.fragile;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
      <span style={{ fontSize: 10, color: C.faint }}>signal / risque · expérimental, complémentaire au verdict :</span>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {signal !== null && (
          <div style={{ fontSize: 11.5, fontFamily: FONT_MONO }}>
            <span style={{ color: C.faint }}>Signal </span>
            <b style={{ color: barColor(signal, false) }}>{signal}/100</b>
          </div>
        )}
        {risk !== null && (
          <div style={{ fontSize: 11.5, fontFamily: FONT_MONO }}>
            <span style={{ color: C.faint }}>Risque </span>
            <b style={{ color: barColor(risk, true) }}>{risk}/100</b>
          </div>
        )}
        {convergence && (
          <div style={{ fontSize: 11.5, fontFamily: FONT_MONO }}>
            <span style={{ color: C.faint }}>Convergence </span>
            <b style={{ color: barColor(convergence.pct, false) }}>{convergence.pct}%</b>
            <span style={{ color: C.faint }}> ({convergence.aligned}/{convergence.total})</span>
          </div>
        )}
      </div>
      {rc && (
        <div style={{ fontSize: 10.5, color: C.faint, fontFamily: FONT_MONO }}>
          RC {rc.labelA} <b style={{ color: C.teamA }}>{rc.rcA.toFixed(2)}</b> · RC {rc.labelB}{" "}
          <b style={{ color: C.teamB }}>{rc.rcB.toFixed(2)}</b> · Δ{" "}
          <b style={{ color: C.text }}>{rc.delta >= 0 ? "+" : ""}{rc.delta.toFixed(2)}</b>
        </div>
      )}
    </div>
  );
}

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
/* Jauge à 3 segments (Victoire / Nul / Défaite) — même principe que SplitBar, mais avec
   le Nul VISIBLE sur la barre au lieu d'être relégué en texte à côté (contrairement à
   ClubElo, où le % de nul est affiché mais absent du dégradé visuel). Les 3 pourcentages
   sont normalisés pour toujours sommer à 100%, donc la barre reste juste même si les
   chiffres d'entrée ont un léger arrondi. */
function ThreeWayBar({ pctVic, pctNul, pctDef, labelVic, labelDef, colorVic = C.solide, colorDef = C.fragile, colorNul = C.faint }) {
  const total = pctVic + pctNul + pctDef || 1;
  const v = (pctVic / total) * 100;
  const n = (pctNul / total) * 100;
  const d = (pctDef / total) * 100;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: FONT_MONO, marginBottom: 4 }}>
        <span style={{ color: colorVic, fontWeight: 700 }}>{labelVic} {v.toFixed(0)}%</span>
        <span style={{ color: colorNul, fontWeight: 700 }}>Nul {n.toFixed(0)}%</span>
        <span style={{ color: colorDef, fontWeight: 700 }}>{labelDef} {d.toFixed(0)}%</span>
      </div>
      <div style={{ display: "flex", height: 6, borderRadius: 4, overflow: "hidden", background: C.surface2 }}>
        <div style={{ width: `${v}%`, background: colorVic }} />
        <div style={{ width: `${n}%`, background: colorNul }} />
        <div style={{ width: `${d}%`, background: colorDef }} />
      </div>
    </div>
  );
}
/* Petite barre Over/Under (fréquence réelle, pas une projection) pour UNE équipe sur
   SON historique propre — volontairement neutre en couleur (ni vert ni rouge) car
   "Over" n'est ni bon ni mauvais en soi, ça dépend du pari. */
function OuBar({ ou, label }) {
  if (!ou) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 9.5, color: C.faint, marginBottom: 2, fontFamily: FONT_MONO }}>{label} ({ou.n})</div>
      <SplitBar
        left={ou.over}
        right={ou.under}
        colorLeft={C.dim}
        colorRight={C.faint}
        labelLeft={`Over ${ou.pctOver.toFixed(0)}%`}
        labelRight={`Under ${(100 - ou.pctOver).toFixed(0)}%`}
      />
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

/* Taux Over/Under réel (fréquence empirique) sur le total match complet (obtenus +
   concédés dans CHAQUE match propre de l'équipe) comparé à une ligne — sert de garde-fou
   face à la projection par MOYENNE (EWMA), qui peut afficher un total élevé/faible sans
   que ça reflète la fréquence réelle des matchs Over/Under (une moyenne est sensible à
   quelques matchs extrêmes, une fréquence empirique beaucoup moins). Ligne volontairement
   en .5 (jamais un entier) pour ne jamais avoir de push dans ce calcul. */
function computeOverUnder(matches, obtKey, concKey, line) {
  const valid = matches.filter((m) => m[obtKey] !== "" && m[obtKey] !== undefined && m[concKey] !== "" && m[concKey] !== undefined);
  const n = valid.length;
  if (!n) return null;
  let over = 0;
  valid.forEach((m) => {
    if (num(m[obtKey]) + num(m[concKey]) > line) over++;
  });
  return { n, line, over, under: n - over, pctOver: (over / n) * 100 };
}

/* Arrondit une projection décimale à la ligne .5 la plus proche (2.5, 3.5, etc.) —
   utilisé pour comparer la projection du match à une fréquence empirique sur LA MÊME
   ligne que celle projetée, plutôt qu'une ligne fixe qui pourrait être hors sujet pour
   ce match précis (ex : deux équipes très prolifiques où la ligne pertinente est 4.5,
   pas 2.5). */
/* Points par match (PPG) — dérivé directement de vndButs (3×Vic + 1×Nul, divisé par n),
   aucune nouvelle donnée nécessaire : c'est juste une autre lecture du Vic/Nul/Déf déjà
   calculé, dans le format standard utilisé par la plupart des sites de stats. */
function ppgFromVnd(vnd) {
  if (!vnd || !vnd.n) return null;
  return (vnd.vic * 3 + vnd.nul * 1) / vnd.n;
}

/* Clean sheet % — fréquence des matchs sans but encaissé, sur l'historique propre de
   l'équipe. */
function computeCleanSheet(matches, concKey) {
  const valid = matches.filter((m) => m[concKey] !== "" && m[concKey] !== undefined);
  const n = valid.length;
  if (!n) return null;
  const cs = valid.filter((m) => num(m[concKey]) === 0).length;
  return { n, cs, pct: (cs / n) * 100 };
}

/* BTTS % (Both Teams To Score) — fréquence des matchs où l'équipe a marqué ET encaissé
   au moins un but, sur son historique propre. */
function computeBTTS(matches, obtKey, concKey) {
  const valid = matches.filter((m) => m[obtKey] !== "" && m[obtKey] !== undefined && m[concKey] !== "" && m[concKey] !== undefined);
  const n = valid.length;
  if (!n) return null;
  const btts = valid.filter((m) => num(m[obtKey]) > 0 && num(m[concKey]) > 0).length;
  return { n, btts, pct: (btts / n) * 100 };
}

function nearestHalfLine(x) {
  if (x === null || x === undefined || isNaN(x)) return null;
  return Math.round(x - 0.5) + 0.5;
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
  // taux Over/Under buts réel sur ligne fixe 2.5 — voir commentaire sur computeOverUnder
  const ouButs25 = computeOverUnder(matches, "butsObtenus", "butsConcedes", 2.5);
  const csButs = computeCleanSheet(matches, "butsConcedes");
  const bttsButs = computeBTTS(matches, "butsObtenus", "butsConcedes");
  const ppgButs = ppgFromVnd(vndButs);
  // xG (expected goals) — entièrement optionnel, saisi à la main match par match (champ
  // "tirs/att. dangereuses/xG" avancé) ; computeStatSeries filtre déjà automatiquement
  // aux matchs où les deux valeurs sont renseignées, donc null tant qu'aucun xG n'a été
  // saisi, sans planter le reste des calculs.
  const xGSeries = computeStatSeries(matches, "xGObtenus", "xGConcedes", alpha);

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
    ouButs25,
    csButs,
    bttsButs,
    ppgButs,
    xGSeries,
  };
}

const emptyTeam = () => ({ nom: "", obtenus: "", concedes: "", part: "", ewma: "", mode: "moyennes", matches: [], useAdvanced: false, excludedLigues: [], limitRecent: false, recentCount: 10 });

/* Filtre compétitions + limite optionnelle aux N matchs les plus récents — utilisé
   partout où une équipe est analysée (profil solo, comparateur), pour ne jamais avoir
   deux endroits qui filtrent différemment. Le tableau `matches` est toujours trié plus
   récent en premier (nouvelle entrée ajoutée en tête, cf `setMatches([nouveau,
   ...matches])` utilisé partout dans l'appli), donc "N plus récents" = les N premiers
   éléments UNE FOIS les compétitions exclues retirées — pas avant — pour que la limite
   porte sur les matchs réellement pertinents, pas sur un mélange qui inclurait des
   matchs d'une compétition que tu as justement décidé d'ignorer. */
function applyMatchFilters(team) {
  const excludedLigues = team.excludedLigues || [];
  let matches = excludedLigues.length ? team.matches.filter((m) => !excludedLigues.includes(m.ligue || "(non identifiée)")) : team.matches;
  if (team.limitRecent) {
    const n = Math.max(1, Math.round(num(team.recentCount)) || 10);
    matches = matches.slice(0, n);
  }
  return matches;
}

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
      ouButs25: venueStats.ouButs25,
      csButs: venueStats.csButs,
      bttsButs: venueStats.bttsButs,
      ppgButs: venueStats.ppgButs,
      xGSeries: venueStats.xGSeries,
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
      ouButs25: overall.ouButs25,
      csButs: overall.csButs,
      bttsButs: overall.bttsButs,
      ppgButs: overall.ppgButs,
      xGSeries: overall.xGSeries,
    };
  }
  return { nom: team.nom, obtenus: num(team.obtenus), concedes: num(team.concedes), part: team.part, ewma: team.ewma, volatilite: null, source: "manuel", n: 0, tirsSeries: null, attDangSeries: null, mt1Series: null, mt2Series: null, vndTotal: null, vndMT1: null, vndMT2: null, butsSeries: null, vndButs: null, ouButs25: null, csButs: null, bttsButs: null, ppgButs: null, xGSeries: null };
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
    // Domicile/extérieur : le match EXACT du nom complet a toujours la priorité sur le
    // repli mot-clé. Sans ça, deux clubs qui partagent un mot (ex. "CA Independiente" et
    // "Independiente Rivadavia", deux clubs argentins différents) peuvent déclencher le
    // repli des DEUX côtés à la fois — et l'ancien code retombait alors sur "domicile"
    // par défaut sans vérifier, inversant silencieusement domicile/extérieur (et donc le
    // score, les corners, les attaques) à chaque fois que l'équipe suivie jouait contre
    // un adversaire au nom proche. Repli mot-clé gardé UNIQUEMENT quand aucun des deux
    // côtés n'a de match exact — et si les DEUX côtés matchent par mot-clé (collision
    // ambiguë), on ignore le match plutôt que de deviner et risquer l'inversion.
    const exactHome = target && zoneHome.includes(target);
    const exactAway = target && zoneAway.includes(target);
    let isHome, isAway;
    if (exactHome || exactAway) {
      isHome = exactHome;
      isAway = exactAway && !exactHome;
    } else {
      const wordHome = target && matchWord(zoneHome);
      const wordAway = target && matchWord(zoneAway);
      isHome = wordHome && !wordAway;
      isAway = wordAway && !wordHome;
    }

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

function MatchHistoryRows({ matches, setMatches, color, teamName, useAdvanced, onToggleAdvanced, excludedLigues, onToggleLigue, onTeamNameDetected, limitRecent, recentCount, onToggleRecent, onChangeRecentCount }) {
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
      {matches.length > 10 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={onToggleRecent}
            title={
              limitRecent
                ? "Désactive la limite (recalcule sur tout l'historique saisi, toutes saisons confondues)"
                : "Limite le calcul aux matchs les plus récents — évite de mélanger la saison en cours avec une saison précédente"
            }
            style={{
              fontSize: 10,
              color: limitRecent ? color : C.faint,
              background: limitRecent ? color + "18" : "transparent",
              border: `1px ${limitRecent ? "solid" : "dashed"} ${limitRecent ? color + "55" : C.line}`,
              borderRadius: 6,
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            {limitRecent ? "✓ activé" : "+ activer"} limiter aux N derniers matchs
          </button>
          {limitRecent && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <NumInput value={recentCount} onChange={onChangeRecentCount} placeholder="10" accent={color} />
              <span style={{ fontSize: 10, color: C.faint }}>matchs (sur {matches.length} saisis)</span>
            </div>
          )}
        </div>
      )}
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
              <div style={{ display: "flex", gap: 5, alignItems: "center", paddingLeft: 18 }}>
                <NumInput value={m.xGObtenus || ""} onChange={(v) => update(m.id, { ...m, xGObtenus: v })} placeholder="xG créé" accent={C.faint} />
                <NumInput value={m.xGConcedes || ""} onChange={(v) => update(m.id, { ...m, xGConcedes: v })} placeholder="xG concédé" accent={C.faint} />
              </div>
            </>
          )}
        </div>
      ))}
      <button
        onClick={() => setMatches([{ id: uid(), obtenus: "", concedes: "", lieu: "", tirsObtenus: "", tirsConcedes: "", attDangObtenus: "", attDangConcedes: "", corners1MTObtenus: "", corners1MTConcedes: "", corners2MTObtenus: "", corners2MTConcedes: "", butsObtenus: "", butsConcedes: "", xGObtenus: "", xGConcedes: "", ligue: "", date: "" }, ...matches])}
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
  const filteredMatches = applyMatchFilters(team);
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
            limitRecent={!!team.limitRecent}
            recentCount={team.recentCount ?? 10}
            onToggleRecent={() => setTeam({ ...team, limitRecent: !team.limitRecent })}
            onChangeRecentCount={(v) => setTeam({ ...team, recentCount: v })}
          />
          {stats ? (
            <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim, display: "flex", flexDirection: "column", gap: 3 }}>
              <div>
                Calculé sur <b style={{ color: C.text }}>{stats.n}</b> match{stats.n > 1 ? "s" : ""}{" "}
                <span style={{ color: C.faint }}>
                  (tous lieux confondus
                  {excludedLigues.length ? ` · ${excludedLigues.length} compétition${excludedLigues.length > 1 ? "s" : ""} exclue${excludedLigues.length > 1 ? "s" : ""}` : ""}
                  {team.limitRecent ? ` · limité aux ${team.recentCount ?? 10} plus récents` : ""})
                </span>
              </div>
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
          {(eloA.fromCache || eloB.fromCache) && (
            <div style={{ fontSize: 10, color: eloA.stale || eloB.stale ? C.jouable : C.faint, textAlign: "center" }}>
              {eloA.stale || eloB.stale
                ? "⚠️ ClubElo injoignable à l'instant — dernière donnée connue réutilisée (peut-être un peu ancienne)"
                : "donnée en cache (moins de 12h) — pas de nouvel appel à ClubElo"}
            </div>
          )}
          {matchup && (
            <>
              <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 }}>
                <ThreeWayBar
                  pctVic={matchup.pHome * 100}
                  pctNul={matchup.pDraw * 100}
                  pctDef={matchup.pAway * 100}
                  labelVic={eloA.club}
                  labelDef={eloB.club}
                  colorVic={C.teamA}
                  colorDef={C.teamB}
                />
                <div style={{ textAlign: "center", fontSize: 11, color: C.faint, marginTop: 6 }}>
                  écart Elo {matchup.diff >= 0 ? "+" : ""}{matchup.diff.toFixed(0)} (avantage terrain de {eloA.club} déjà inclus)
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
function SecondaryStatPanel({ label, unit, seriesA, seriesB, sourceA, sourceB, teamAName, teamBName, showHandicapSignal = false, showRatioVerdict = false, showFormLabels = false, showXgExtras = false, crossVenueAgree = null, vndA = null, vndB = null, ouFixedA = null, ouFixedB = null, ouDynamicA = null, ouDynamicB = null, ppgA = null, ppgB = null, csA = null, csB = null, bttsA = null, bttsB = null, leagueAvg = null, xgFinishA = null, xgFinishB = null, xgPerShotA = null, xgPerShotB = null, attDangA = null, attDangB = null }) {
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
  const favoriSide = ratioVerdict ? (ratioVerdict.sens === "Over" ? "A" : "B") : null;
  const ratioFavori = ratioVerdict ? (favoriSide === "A" ? teamAName || "Équipe A" : teamBName || "Équipe B") : null;
  // forme individuelle de chaque équipe (Bonne forme/En forme/Neutre/Difficultés/En
  // perdition) — indépendant du duel, contrairement au verdict ci-dessus qui compare
  // les deux équipes entre elles
  const formA = showFormLabels ? computeFormLabel(seriesA) : null;
  const formB = showFormLabels ? computeFormLabel(seriesB) : null;

  // Signal / Risque / Convergence / RC — voir le commentaire au-dessus de
  // computeSignalScore pour le raisonnement. Checks de convergence : EWMA d'accord avec
  // le favori, part d'accord avec le favori, et (si transmis par le parent) le favori
  // "tous lieux confondus" d'accord avec le favori "domicile/extérieur" — exactement le
  // point soulevé dans l'analyse externe (Real vs Ferretti : proj domicile/ext ≈ proj
  // globale).
  const signalScore = ratioVerdict ? computeSignalScore(ratioVerdict.ratio) : null;
  const riskScore = ratioVerdict ? computeRiskScore(ratioVerdict.vol, proj.total, Math.min(seriesA.n, seriesB.n)) : null;
  const ewmaCheck = favoriSide && seriesA.ewma !== seriesB.ewma ? (seriesA.ewma > seriesB.ewma ? "A" : "B") === favoriSide : null;
  const partCheck = favoriSide && seriesA.part !== seriesB.part ? (seriesA.part > seriesB.part ? "A" : "B") === favoriSide : null;
  // check "forme" — comparaison sur le ratio SIGNÉ (voir computeFormLabel), donc valable
  // sur toute la plage (Neutre/En forme/Difficultés compris, pas seulement les cas
  // extrêmes Bonne forme/En perdition) : c'est un check indépendant du EWMA brut
  // ci-dessus, puisque diviser par la volatilité propre à chaque équipe peut inverser
  // l'ordre (ex : EWMA A > EWMA B mais A bien plus volatile que B → ratio signé B > A).
  const formGapCheck = favoriSide && formA && formB && formA.signedRatio !== formB.signedRatio
    ? (formA.signedRatio > formB.signedRatio ? "A" : "B") === favoriSide
    : null;
  const convergence = showRatioVerdict ? computeConvergence([ewmaCheck, partCheck, crossVenueAgree, formGapCheck]) : null;
  const rcA = showRatioVerdict ? computeRatioCumule({ projSide: proj.projA, projOther: proj.projB, ewma: seriesA.ewma, vol: seriesA.volatilite, part: seriesA.part }) : null;
  const rcB = showRatioVerdict ? computeRatioCumule({ projSide: proj.projB, projOther: proj.projA, ewma: seriesB.ewma, vol: seriesB.volatilite, part: seriesB.part }) : null;
  const rc = rcA && rcB ? { rcA: rcA.rc, rcB: rcB.rc, delta: rcA.rc - rcB.rc, labelA: teamAName || "A", labelB: teamBName || "B" } : null;

  // Risques cachés combinés — deux checks FACTUELS (pas un score composite inventé) :
  // 1) l'adversaire du favori a-t-il une attaque dangereuse (EWMA) plus forte que le
  //    favori lui-même ? Utilise la MÊME méthode de projection croisée que le panneau
  //    "Attaques dangereuses" existant (ce que chaque équipe est censée produire FACE À
  //    LA DÉFENSE de l'autre, pas juste sa moyenne brute dans l'absolu) — pour rester
  //    cohérent avec ce que tu vois déjà ailleurs dans l'appli plutôt que d'introduire un
  //    troisième calcul différent qui donnerait des chiffres difficiles à recouper.
  // 2) le favori lui-même perd/encaisse-t-il plus souvent que la moyenne de sa ligue ?
  //    Le seuil ici n'est PAS inventé — c'est la moyenne ligue réelle déjà calculée
  //    (voir leagueStats.js), donc ancré dans des données observées plutôt que dans une
  //    intuition. Les deux restent des DRAPEAUX affichés côte à côte, jamais fusionnés
  //    en un chiffre unique ni intégrés au verdict — jusqu'à ce qu'un vrai backtest
  //    montre qu'ils prédisent quelque chose.
  const attDangProj =
    attDangA && attDangB && attDangA.moyObtenus !== undefined && attDangB.moyObtenus !== undefined
      ? projection(attDangA.moyObtenus, attDangB.moyConcedes, attDangB.moyObtenus, attDangA.moyConcedes)
      : null;
  const favoriAttDangSide = attDangProj && attDangProj.projA !== attDangProj.projB ? (attDangProj.projA > attDangProj.projB ? "A" : "B") : null;
  const adversaireDangereuxCheck = favoriSide && favoriAttDangSide ? favoriAttDangSide !== favoriSide : null;
  const favoriVnd = favoriSide === "A" ? vndA : favoriSide === "B" ? vndB : null;
  const favoriDefPct = favoriVnd && favoriVnd.n ? (favoriVnd.def / favoriVnd.n) * 100 : null;
  const favoriFragileCheck =
    favoriDefPct !== null && leagueAvg && !leagueAvg.insufficient && leagueAvg.defPct !== null ? favoriDefPct > leagueAvg.defPct : null;
  const dangerChecks = [adversaireDangereuxCheck, favoriFragileCheck].filter((c) => c !== null && c !== undefined);
  const dangerCount = dangerChecks.filter(Boolean).length;

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

      {showXgExtras && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <span style={{ fontSize: 10, color: C.faint }}>
            xG pour/contre détaillé (EWMA séparé, pas juste le net ci-dessus) · avantage à la finition · xG par tir :
          </span>
          <div style={{ fontSize: 11, fontFamily: FONT_MONO, color: C.dim, display: "flex", flexWrap: "wrap", gap: 4 }}>
            <span style={{ color: C.teamA, marginRight: 4 }}>{teamAName || "Équipe A"}</span>
            <span>xG pour <b style={{ color: C.text }}>{seriesA.ewmaObtenus.toFixed(2)}</b></span>
            <span>· xG contre <b style={{ color: C.text }}>{seriesA.ewmaConcedes.toFixed(2)}</b></span>
            {xgFinishA !== null && (
              <span>
                · finition{" "}
                <b style={{ color: xgFinishA >= 0 ? C.solide : C.fragile }}>
                  {xgFinishA >= 0 ? "+" : ""}
                  {xgFinishA.toFixed(2)}
                </b>
              </span>
            )}
            {xgPerShotA !== null && <span>· xG/tir <b style={{ color: C.text }}>{xgPerShotA.toFixed(2)}</b></span>}
          </div>
          <div style={{ fontSize: 11, fontFamily: FONT_MONO, color: C.dim, display: "flex", flexWrap: "wrap", gap: 4 }}>
            <span style={{ color: C.teamB, marginRight: 4 }}>{teamBName || "Équipe B"}</span>
            <span>xG pour <b style={{ color: C.text }}>{seriesB.ewmaObtenus.toFixed(2)}</b></span>
            <span>· xG contre <b style={{ color: C.text }}>{seriesB.ewmaConcedes.toFixed(2)}</b></span>
            {xgFinishB !== null && (
              <span>
                · finition{" "}
                <b style={{ color: xgFinishB >= 0 ? C.solide : C.fragile }}>
                  {xgFinishB >= 0 ? "+" : ""}
                  {xgFinishB.toFixed(2)}
                </b>
              </span>
            )}
            {xgPerShotB !== null && <span>· xG/tir <b style={{ color: C.text }}>{xgPerShotB.toFixed(2)}</b></span>}
          </div>
          <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic" }}>
            finition = buts marqués (EWMA) − xG créés (EWMA) : positif = finisseur plus clinique que la qualité de ses
            occasions ne le suggère, négatif = gâche des occasions nettes. xG/tir = qualité moyenne des occasions
            (nécessite les tirs saisis).
          </div>
        </div>
      )}

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

      {showRatioVerdict && <SignalRiskRow signal={signalScore} risk={riskScore} convergence={convergence} rc={rc} />}

      {showRatioVerdict && dangerChecks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: C.faint }}>risques cachés (observationnel, ne pèse pas sur le verdict) :</span>
            <Pill color={dangerCount === 0 ? C.solide : dangerCount === dangerChecks.length ? C.fragile : C.jouable}>
              {dangerCount}/{dangerChecks.length}
            </Pill>
          </div>
          {adversaireDangereuxCheck !== null && (
            <div style={{ fontSize: 11, color: adversaireDangereuxCheck ? C.fragile : C.dim }}>
              {adversaireDangereuxCheck ? "⚠️ " : "✓ "}
              adversaire du favori plus dangereux (proj. att. dang. {favoriSide === "A" ? teamBName || "B" : teamAName || "A"} (adversaire){" "}
              <b>{(favoriSide === "A" ? attDangProj.projB : attDangProj.projA).toFixed(1)}</b> vs {favoriSide === "A" ? teamAName || "A" : teamBName || "B"}{" "}
              (favori) <b>{(favoriSide === "A" ? attDangProj.projA : attDangProj.projB).toFixed(1)}</b>)
            </div>
          )}
          {favoriFragileCheck !== null && (
            <div style={{ fontSize: 11, color: favoriFragileCheck ? C.fragile : C.dim }}>
              {favoriFragileCheck ? "⚠️ " : "✓ "}
              favori ({favoriSide === "A" ? teamAName || "A" : teamBName || "B"}) Déf <b>{favoriDefPct.toFixed(0)}%</b> vs moyenne ligue{" "}
              <b>{leagueAvg.defPct.toFixed(0)}%</b>
            </div>
          )}
        </div>
      )}

      {(vndA || vndB) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <span style={{ fontSize: 10, color: C.faint }}>historique Vic/Nul/Déf de chaque équipe sur les {label.toLowerCase()} — {sourceA === sourceB ? sourceA : `${sourceA} / ${sourceB}`} :</span>
          {vndA && (
            <div>
              <span style={{ fontSize: 10, color: C.teamA }}>{teamAName || "Équipe A"} ({vndA.n})</span>
              <ThreeWayBar pctVic={vndA.vic} pctNul={vndA.nul} pctDef={vndA.def} labelVic="Vic" labelDef="Déf" colorVic={C.solide} colorDef={C.fragile} />
            </div>
          )}
          {vndB && (
            <div>
              <span style={{ fontSize: 10, color: C.teamB }}>{teamBName || "Équipe B"} ({vndB.n})</span>
              <ThreeWayBar pctVic={vndB.vic} pctNul={vndB.nul} pctDef={vndB.def} labelVic="Vic" labelDef="Déf" colorVic={C.solide} colorDef={C.fragile} />
            </div>
          )}
          {leagueAvg && !leagueAvg.insufficient && leagueAvg.vicPct !== null && (
            <div style={{ fontSize: 10, color: C.faint, fontFamily: FONT_MONO }}>
              moyenne ligue (Vic) : <b style={{ color: C.dim }}>{leagueAvg.vicPct.toFixed(0)}%</b> — sur {leagueAvg.nTeams} équipes suivies dans cette ligue
            </div>
          )}
        </div>
      )}

      {(ouFixedA || ouFixedB || ouDynamicA || ouDynamicB) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <span style={{ fontSize: 10, color: C.faint }}>
            taux Over/Under RÉEL de chaque équipe (fréquence sur son historique propre — à comparer à la projection par
            moyenne ci-dessus, qui peut diverger si quelques matchs extrêmes tirent la moyenne) :
          </span>
          {(ouFixedA || ouDynamicA) && (
            <div>
              <span style={{ fontSize: 10, color: C.teamA }}>{teamAName || "Équipe A"}</span>
              <OuBar ou={ouFixedA} label="ligne 2.5 (fixe)" />
              {ouDynamicA && <OuBar ou={ouDynamicA} label={`ligne ${ouDynamicA.line} (≈ projection du match)`} />}
            </div>
          )}
          {(ouFixedB || ouDynamicB) && (
            <div>
              <span style={{ fontSize: 10, color: C.teamB }}>{teamBName || "Équipe B"}</span>
              <OuBar ou={ouFixedB} label="ligne 2.5 (fixe)" />
              {ouDynamicB && <OuBar ou={ouDynamicB} label={`ligne ${ouDynamicB.line} (≈ projection du match)`} />}
            </div>
          )}
        </div>
      )}

      {(ppgA !== null || ppgB !== null || csA || csB || bttsA || bttsB) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <span style={{ fontSize: 10, color: C.faint }}>PPG · Clean sheet · BTTS (historique propre de chaque équipe) :</span>
          {(ppgA !== null || csA || bttsA) && (
            <div style={{ fontSize: 11, fontFamily: FONT_MONO, color: C.dim, display: "flex", flexWrap: "wrap", gap: 4 }}>
              <span style={{ color: C.teamA, marginRight: 4 }}>{teamAName || "Équipe A"}</span>
              {ppgA !== null && <span>PPG <b style={{ color: C.text }}>{ppgA.toFixed(2)}</b></span>}
              {csA && <span>· Clean sheet <b style={{ color: C.text }}>{csA.pct.toFixed(0)}%</b> ({csA.n})</span>}
              {bttsA && <span>· BTTS <b style={{ color: C.text }}>{bttsA.pct.toFixed(0)}%</b> ({bttsA.n})</span>}
            </div>
          )}
          {(ppgB !== null || csB || bttsB) && (
            <div style={{ fontSize: 11, fontFamily: FONT_MONO, color: C.dim, display: "flex", flexWrap: "wrap", gap: 4 }}>
              <span style={{ color: C.teamB, marginRight: 4 }}>{teamBName || "Équipe B"}</span>
              {ppgB !== null && <span>PPG <b style={{ color: C.text }}>{ppgB.toFixed(2)}</b></span>}
              {csB && <span>· Clean sheet <b style={{ color: C.text }}>{csB.pct.toFixed(0)}%</b> ({csB.n})</span>}
              {bttsB && <span>· BTTS <b style={{ color: C.text }}>{bttsB.pct.toFixed(0)}%</b> ({bttsB.n})</span>}
            </div>
          )}
          {leagueAvg && !leagueAvg.insufficient && (leagueAvg.csPct !== null || leagueAvg.bttsPct !== null || leagueAvg.overPct !== null) && (
            <div style={{ fontSize: 10, color: C.faint, fontFamily: FONT_MONO, marginTop: 2 }}>
              moyenne ligue :
              {leagueAvg.csPct !== null && <> Clean sheet <b style={{ color: C.dim }}>{leagueAvg.csPct.toFixed(0)}%</b></>}
              {leagueAvg.bttsPct !== null && <> · BTTS <b style={{ color: C.dim }}>{leagueAvg.bttsPct.toFixed(0)}%</b></>}
              {leagueAvg.overPct !== null && <> · Over 2.5 <b style={{ color: C.dim }}>{leagueAvg.overPct.toFixed(0)}%</b></>}
              {" "}— sur {leagueAvg.nTeams} équipes
            </div>
          )}
          {leagueAvg && leagueAvg.insufficient && (
            <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic", marginTop: 2 }}>
              moyenne ligue pas encore assez fiable ({leagueAvg.nTeams}/3 équipes suivies dans cette ligue) — se construit au
              fil de tes analyses.
            </div>
          )}
        </div>
      )}

      {(formA || formB) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <span style={{ fontSize: 10, color: C.faint }}>forme individuelle (indépendante du duel) :</span>
          {formA && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: C.teamA, minWidth: 70 }}>{teamAName || "Équipe A"}</span>
              <Pill color={formA.color}>{formA.label}</Pill>
              <span style={{ color: C.faint, fontSize: 10 }}>
                {formA.signedRatio >= 0 ? "+" : ""}{formA.signedRatio.toFixed(2)}×
              </span>
            </div>
          )}
          {formB && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: C.teamB, minWidth: 70 }}>{teamBName || "Équipe B"}</span>
              <Pill color={formB.color}>{formB.label}</Pill>
              <span style={{ color: C.faint, fontSize: 10 }}>
                {formB.signedRatio >= 0 ? "+" : ""}{formB.signedRatio.toFixed(2)}×
              </span>
            </div>
          )}
          {formA && formB && (
            <div style={{ fontSize: 11, fontFamily: FONT_MONO, marginTop: 2 }}>
              <span style={{ color: C.faint }}>écart de forme (signé, {teamAName || "A"} − {teamBName || "B"}) : </span>
              <b style={{ color: formA.signedRatio - formB.signedRatio >= 0 ? C.teamA : C.teamB }}>
                {formA.signedRatio - formB.signedRatio >= 0 ? "+" : ""}
                {(formA.signedRatio - formB.signedRatio).toFixed(2)}
              </b>
            </div>
          )}
          <div style={{ fontSize: 9.5, color: C.faint, fontStyle: "italic", marginTop: 2 }}>
            ratio signé (positif = bonne forme, négatif = mauvaise) — contrairement à un ratio en valeur absolue, celui-ci
            permet de comparer directement les deux équipes sans biais : "Bonne forme +1.44" et "En perdition -1.05" ont
            un écart réel de 2.49, pas 0.39
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
  const mean = (arr) => arr.reduce((s, t) => s + t, 0) / arr.length;
  const std = (arr, m) => Math.sqrt(arr.reduce((s, t) => s + (t - m) ** 2, 0) / arr.length);
  const ewmaOf = (arr) => {
    const chrono = [...arr].reverse(); // liste = plus récent en premier, on inverse pour l'EWMA
    let e = null;
    chrono.forEach((t) => (e = e === null ? t : alpha * t + (1 - alpha) * e));
    return e;
  };

  let corners = null;
  if (valid.length) {
    const n = valid.length;
    const aVals = valid.map((m) => num(m.obtenusA));
    const bVals = valid.map((m) => num(m.obtenusB));
    const totals = valid.map((m) => num(m.obtenusA) + num(m.obtenusB));
    const moyenneTotal = mean(totals);
    const moyenneA = mean(aVals);
    const moyenneB = mean(bVals);
    const seuils = [7.5, 8.5, 9.5, 10.5];
    const overRates = {};
    seuils.forEach((s) => (overRates[s] = totals.filter((t) => t > s).length / n));
    corners = {
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

  // Buts H2H — même principe que les corners ci-dessus (brute/pondérée/volatilité), PLUS
  // un découpage par qui recevait (home: "A"|"B"). Contrairement aux corners, l'avantage
  // du terrain influence fortement les buts (une équipe qui reçoit marque en général
  // plus qu'en déplacement), donc regrouper "A domicile" et "B domicile" dans une seule
  // moyenne masquerait cette asymétrie — d'où les deux sous-blocs whenAHome/whenBHome.
  const validButs = matches.filter((m) => m.butsA !== "" && m.butsA !== undefined && m.butsB !== "" && m.butsB !== undefined);
  let buts = null;
  if (validButs.length) {
    const nB = validButs.length;
    const aB = validButs.map((m) => num(m.butsA));
    const bB = validButs.map((m) => num(m.butsB));
    const totalsB = validButs.map((m) => num(m.butsA) + num(m.butsB));
    const moyenneTotalB = mean(totalsB);
    const splitStats = (subset) =>
      subset.length
        ? {
            n: subset.length,
            moyenneTotal: mean(subset.map((m) => num(m.butsA) + num(m.butsB))),
            moyenneA: mean(subset.map((m) => num(m.butsA))),
            moyenneB: mean(subset.map((m) => num(m.butsB))),
          }
        : null;
    buts = {
      n: nB,
      moyenneTotal: moyenneTotalB,
      moyennePondereeTotal: ewmaOf(totalsB),
      volatiliteTotal: std(totalsB, moyenneTotalB),
      moyenneA: mean(aB),
      moyennePondereeA: ewmaOf(aB),
      moyenneB: mean(bB),
      moyennePondereeB: ewmaOf(bB),
      whenAHome: splitStats(validButs.filter((m) => m.home === "A")),
      whenBHome: splitStats(validButs.filter((m) => m.home === "B")),
    };
  }

  if (!corners && !buts) return null;
  return { ...corners, buts };
}

/* ---------------------------------------------------------------
   EXTRACTION H2H DEPUIS UNE PHOTO — OCR LOCAL (Tesseract.js), EXPÉRIMENTAL
   ---------------------------------------------------------------
   Alternative à "Extraction auto" (collage de texte) pour les tableaux "Face-à-
   face" de type Forebet/SofaScore : l'utilisateur prend une photo au lieu de
   copier-coller. Tourne ENTIÈREMENT dans le navigateur (aucun serveur, aucune
   clé API) — moins fiable que le collage de texte car ça passe par de la
   reconnaissance d'image, donc à toujours vérifier avant de faire confiance
   aux chiffres importés (comme le rappelle systématiquement l'app pour les
   autres extractions auto).

   Tesseract.js n'est PAS une dépendance npm du projet ici (pour rester sur un
   seul fichier à modifier) : il est chargé à la demande depuis un CDN, la
   première fois que l'utilisateur utilise cette fonction. Ça veut dire qu'une
   connexion internet est nécessaire au moment de l'extraction (mais pas pour
   le reste de l'app).

   Principe en 3 étapes :
   1) OCR mot par mot (avec position x/y de chaque mot, pas juste le texte
      brut) — nécessaire car un tableau a plusieurs colonnes, et Tesseract ne
      les lit pas forcément dans le bon ordre s'il ne se base que sur ses
      propres blocs de texte.
   2) Reconstruction des LIGNES du tableau en regroupant les mots par bande
      verticale (y proche), puis en les triant par x pour retrouver l'ordre
      de lecture gauche→droite. Les sites comme Forebet affichent la date sur
      deux lignes (jour/mois puis année) à côté d'une ligne "équipe – score –
      équipe" sur une seule ligne : la ligne "année" (uniquement des chiffres/
      parenthèses) est donc rattachée à la ligne précédente plutôt que traitée
      comme une ligne à part.
   3) Sur chaque ligne reconstruite, recherche du score "X - Y" (en ignorant
      la mi-temps entre parenthèses), puis identification de quelle équipe
      (A ou B, par mot-clé de nom) apparaît avant / après ce score. Une ligne
      où les deux noms ne sont pas retrouvés est laissée de côté et affichée
      en clair pour saisie manuelle, plutôt que silencieusement ignorée.
   Domicile/extérieur n'est PAS déduit de la photo (le gras n'est pas fiable en
   OCR) — les matchs importés ainsi ont "home" non renseigné, comme le format
   "corners" classique du collage en vrac. */

let tesseractLoadPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    script.async = true;
    script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract indisponible après chargement")));
    script.onerror = () => reject(new Error("Impossible de charger Tesseract.js (vérifie ta connexion internet)"));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// Regroupe les mots OCR (avec bbox {x0,y0,x1,y1}) en lignes de tableau par
// proximité verticale, puis trie chaque ligne par x. Un mot rejoint la ligne en
// cours si son centre y est à moins de 70% de la hauteur de mot la plus haute
// (la sienne ou celle de la ligne) — sinon il démarre une nouvelle ligne.
function clusterOcrRows(words) {
  const items = (words || [])
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({ text: w.text.trim(), x0: w.bbox.x0, cy: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 }))
    .sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const w of items) {
    const row = rows.find((r) => Math.abs(r.cy - w.cy) < Math.max(r.h, w.h, 8) * 0.7);
    if (row) {
      row.words.push(w);
      row.cy = (row.cy * (row.words.length - 1) + w.cy) / row.words.length;
      row.h = Math.max(row.h, w.h);
    } else {
      rows.push({ cy: w.cy, h: w.h, words: [w] });
    }
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.map((r) =>
    r.words
      .sort((a, b) => a.x0 - b.x0)
      .map((w) => w.text)
      .join(" ")
  );
}

// Rattache à la ligne précédente toute ligne "uniquement chiffres/parenthèses/
// tirets" (ex. une année seule "2026", ou une mi-temps seule "(0 - 0)") — c'est
// le repli de la ligne date/mi-temps qui, sur deux sous-lignes dans l'image,
// finit dans un cluster séparé au lieu de la ligne "équipe - score - équipe".
function mergeContinuationRows(rowTexts) {
  const merged = [];
  for (const t of rowTexts) {
    const isContinuation = /^[\d\s().-]+$/.test(t) && merged.length > 0;
    if (isContinuation) merged[merged.length - 1] += " " + t;
    else merged.push(t);
  }
  return merged;
}

function parsePhotoH2hRows(rowTexts, teamAName, teamBName) {
  const aWord = (teamAName || "").trim().toLowerCase().split(/\s+/).find((w) => w.length >= 3) || "";
  const bWord = (teamBName || "").trim().toLowerCase().split(/\s+/).find((w) => w.length >= 3) || "";
  const results = [];
  const skipped = [];
  if (!aWord || !bWord) return { results, skipped: rowTexts };

  for (const raw of rowTexts) {
    // retire la mi-temps entre parenthèses pour ne pas la confondre avec le score
    const withoutHalf = raw.replace(/\([^)]*\)/g, " ");
    const scoreMatch = withoutHalf.match(/(\d+)\s*-\s*(\d+)/);
    if (!scoreMatch || scoreMatch.index === undefined) continue; // pas une ligne de match (titre, légende...)

    const before = withoutHalf.slice(0, scoreMatch.index).toLowerCase();
    const after = withoutHalf.slice(scoreMatch.index + scoreMatch[0].length).toLowerCase();
    const leftGoals = scoreMatch[1];
    const rightGoals = scoreMatch[2];

    const aLeft = before.includes(aWord);
    const bLeft = before.includes(bWord);
    const aRight = after.includes(aWord);
    const bRight = after.includes(bWord);

    let butsA = null, butsB = null;
    if (aLeft && bRight) { butsA = leftGoals; butsB = rightGoals; }
    else if (bLeft && aRight) { butsA = rightGoals; butsB = leftGoals; }

    if (butsA === null) { skipped.push(raw); continue; }

    // date en 2 morceaux ("19.04" puis "2026" plus loin sur la ligne fusionnée, pas
    // forcément adjacents une fois la ligne de continuation recollée en fin de chaîne)
    const dmMatch = raw.match(/\b(\d{2})[.\/](\d{2})\b/);
    const yearMatch = raw.match(/\b(19|20)\d{2}\b/);
    const dateStr = dmMatch && yearMatch ? `${dmMatch[1]}/${dmMatch[2]}/${yearMatch[0]}` : "";
    results.push({
      id: uid(),
      obtenusA: "",
      obtenusB: "",
      home: null,
      butsA,
      butsB,
      date: dateStr,
    });
  }
  return { results, skipped };
}

// Même parseur que la photo (voir plus haut), mais sur du texte COLLÉ directement — pas
// besoin de reconstruction OCR puisque les retours à la ligne du copier-coller sont déjà
// fiables. Regroupe les lignes en blocs "un match = tout ce qui suit une ligne DD/MM
// jusqu'à la prochaine" (Forebet, SofaScore et sites similaires affichent la date sur 2
// lignes séparées du reste), puis réutilise exactement la même extraction score/équipes.
function parseH2hPastedTable(text, teamAName, teamBName) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^\d{2}\/\d{2}$/.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  const rowTexts = blocks.map((b) => b.join(" "));
  return parsePhotoH2hRows(rowTexts, teamAName, teamBName);
}

function PhotoExtractH2h({ teamAName, teamBName, onImport }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [skipped, setSkipped] = useState([]);

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // permet de re-sélectionner la même photo ensuite
    if (!file) return;
    if (!teamAName || !teamAName.trim() || !teamBName || !teamBName.trim()) {
      setError("Renseigne d'abord les deux noms d'équipe ci-dessus (pour identifier les bonnes lignes).");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    setSkipped([]);
    try {
      const Tesseract = await loadTesseract();
      const { data } = await Tesseract.recognize(file, "eng");
      const words = data && data.words ? data.words : [];
      if (!words.length) {
        setError("Aucun texte détecté sur la photo — réessaie avec une image plus nette ou mieux cadrée.");
        return;
      }
      const rows = mergeContinuationRows(clusterOcrRows(words));
      const { results, skipped: notMatched } = parsePhotoH2hRows(rows, teamAName, teamBName);
      if (!results.length) {
        setError(
          `Aucune confrontation reconnue entre "${teamAName}" et "${teamBName}" sur cette photo — vérifie le cadrage, ou utilise "Extraction auto" (collage de texte) à la place.`
        );
        setSkipped(notMatched);
        return;
      }
      onImport(results);
      setInfo(`${results.length} confrontation${results.length > 1 ? "s" : ""} importée${results.length > 1 ? "s" : ""} depuis la photo${notMatched.length ? ` · ${notMatched.length} ligne(s) non reconnue(s) ci-dessous` : ""}. OCR = pas fiable à 100%, vérifie chaque score avant de t'y fier.`);
      setSkipped(notMatched);
    } catch (err) {
      setError(err && err.message ? err.message : "Erreur pendant l'extraction de la photo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label
        style={{
          fontSize: 10.5, color: C.dim, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6,
          padding: "3px 8px", cursor: busy ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
        {busy ? "Lecture de la photo…" : "Extraire depuis une photo"}
        <input type="file" accept="image/*" capture="environment" onChange={handleFile} disabled={busy} style={{ display: "none" }} />
      </label>
      {error && <div style={{ fontSize: 11, color: C.fragile, maxWidth: 260 }}>{error}</div>}
      {info && <div style={{ fontSize: 11, color: C.jouable, maxWidth: 260 }}>{info}</div>}
      {skipped.length > 0 && (
        <div style={{ fontSize: 10, color: C.faint, maxWidth: 260, lineHeight: 1.4 }}>
          Non reconnu(es), à ajouter à la main si utile :
          <br />
          {skipped.map((s, i) => (
            <span key={i}>
              « {s} »
              <br />
            </span>
          ))}
        </div>
      )}
    </div>
  );
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
    // mot-clé (pas le nom complet — "Nagoya" doit matcher même si l'équipe est
    // enregistrée comme "Nagoya Grampus") ; premier mot ≥3 lettres, même logique que le
    // matching de nom déjà utilisé ailleurs dans l'appli (parser TotalCorner)
    const aWord = (teamAName || "").trim().toLowerCase().split(/\s+/).find((w) => w.length >= 3) || "";
    const bWord = (teamBName || "").trim().toLowerCase().split(/\s+/).find((w) => w.length >= 3) || "";
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Tableau "Head to head" multi-lignes (Forebet, SofaScore...) collé tel quel — testé
    // EN PREMIER : ce format a des lignes date seules ("09/03") qui, sinon, seraient
    // happées à tort par le repli "2 nombres = corners" ci-dessous (09 et 03 comme faux
    // corners) avant même d'avoir eu la chance d'être reconnues comme une date.
    const { results: tableResults, skipped: tableSkipped } = parseH2hPastedTable(bulkText, teamAName, teamBName);
    if (tableResults.length) {
      parsed.push(...tableResults);
    } else {
      for (const line of lines) {
        // format buts + domicile : une ligne avec un score "X-Y" et une marque de qui
        // recevait (nom d'équipe reconnu, ou lettre A/B en repli) — ex :
        // "25-09-27 Nagoya 0-4" ou juste "B 0-4"
        const tokens = line.split(/\s+/);
        // le score doit être un token ENTIER "X-Y" (un seul tiret) — sinon une date comme
        // "25-09-27" (deux tirets) se ferait passer pour un score via un regex non ancré
        const scoreTok = tokens.find((t) => /^\d+-\d+$/.test(t));
        if (scoreTok) {
          let home = null;
          if (aWord && new RegExp(`\\b${escapeRe(aWord)}`, "i").test(line)) home = "A";
          else if (bWord && new RegExp(`\\b${escapeRe(bWord)}`, "i").test(line)) home = "B";
          else if (/(^|\s)a(\s|$)/i.test(line)) home = "A";
          else if (/(^|\s)b(\s|$)/i.test(line)) home = "B";
          if (home) {
            const [hVal, aVal] = scoreTok.split("-");
            const butsA = home === "A" ? hVal : aVal;
            const butsB = home === "B" ? hVal : aVal;
            const dateTok = tokens.find((t) => t !== scoreTok && /^\d[\d/-]*\d$/.test(t));
            parsed.push({ id: uid(), obtenusA: "", obtenusB: "", home, butsA, butsB, date: dateTok || "" });
            continue;
          }
        }
        // sinon, format classique : deux nombres = corners équipe A puis B
        const nums = line.match(/-?\d+(\.\d+)?/g);
        if (!nums || nums.length < 2) continue;
        parsed.push({ id: uid(), obtenusA: nums[0], obtenusB: nums[1], home: null, butsA: "", butsB: "", date: "" });
      }
    }
    if (!parsed.length) {
      setBulkError(
        `Aucune ligne reconnue — soit deux nombres (corners ${teamAName || "équipe A"} puis ${teamBName || "équipe B"}, ex : 5 4), soit une ligne avec le nom de l'équipe qui recevait et le score (ex : ${teamAName || "Équipe A"} 1-0), soit un tableau "Head to head" collé tel quel (type Forebet/SofaScore).${tableSkipped.length ? ` ${tableSkipped.length} bloc(s) détecté(s) mais non reconnu(s) (noms d'équipe introuvables dedans).` : ""}`
      );
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
              Un match par ligne (plus récent en haut) — soit corners {teamAName || "équipe A"} puis {teamBName || "équipe B"} (ex : 5 4),
              soit domicile + score buts pour capturer le contexte domicile/extérieur (ex : {teamAName || "Équipe A"} 1-0, ou juste "A 1-0"),
              soit un tableau "Head to head" collé tel quel (type Forebet/SofaScore, avec dates et scores multi-lignes) — détecté automatiquement.
            </div>
            <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={"5 4\n" + (teamAName || "Équipe A") + " 1-0\nB 0-4\n..."} rows={5} style={{ ...inputStyle, resize: "vertical", fontSize: 13 }} />
            {bulkError && <div style={{ fontSize: 11, color: C.fragile }}>{bulkError}</div>}
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={importBulk} style={{ flex: 1, background: C.solide + "22", color: C.solide, border: `1px solid ${C.solide}55`, borderRadius: 6, padding: "6px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Importer</button>
              <button onClick={() => setBulkOpen(false)} style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 10px", color: C.dim, fontSize: 12, cursor: "pointer" }}>Annuler</button>
            </div>
          </div>
        )}
        <RawExtractH2h teamAName={teamAName} teamBName={teamBName} onImport={(parsed) => setH2h([...parsed, ...h2h])} />
        <PhotoExtractH2h teamAName={teamAName} teamBName={teamBName} onImport={(parsed) => setH2h([...parsed, ...h2h])} />
      </div>

      {h2h.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6, fontSize: 10, color: C.faint, fontFamily: FONT_MONO, paddingLeft: 20 }}>
            <span style={{ flex: 1, color: C.teamA }}>{teamAName || "Équipe A"}</span>
            <span style={{ flex: 1, color: C.teamB }}>{teamBName || "Équipe B"}</span>
          </div>
          {h2h.map((m, i) => (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: C.faint, width: 14, fontFamily: FONT_MONO }}>{i + 1}</span>
                <NumInput value={m.obtenusA} onChange={(v) => update(m.id, { ...m, obtenusA: v })} placeholder="corners" accent={C.teamA} />
                <NumInput value={m.obtenusB} onChange={(v) => update(m.id, { ...m, obtenusB: v })} placeholder="corners" accent={C.teamB} />
                <IconBtn onClick={() => remove(m.id)} color={C.faint} title="Supprimer"><Trash2 size={13} /></IconBtn>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", paddingLeft: 20 }}>
                <span style={{ fontSize: 9.5, color: C.faint, flexShrink: 0 }}>domicile :</span>
                <div style={{ display: "flex", flexShrink: 0, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.line}` }}>
                  {["A", "B"].map((v) => (
                    <button
                      key={v}
                      onClick={() => update(m.id, { ...m, home: m.home === v ? null : v })}
                      title={v === "A" ? teamAName || "Équipe A" : teamBName || "Équipe B"}
                      style={{
                        width: 22,
                        height: 24,
                        fontSize: 10,
                        fontWeight: 700,
                        border: "none",
                        background: m.home === v ? (v === "A" ? C.teamA : C.teamB) + "33" : C.surface2,
                        color: m.home === v ? (v === "A" ? C.teamA : C.teamB) : C.faint,
                        cursor: "pointer",
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <NumInput value={m.butsA || ""} onChange={(v) => update(m.id, { ...m, butsA: v })} placeholder="buts A" accent={C.teamA} />
                <NumInput value={m.butsB || ""} onChange={(v) => update(m.id, { ...m, butsB: v })} placeholder="buts B" accent={C.teamB} />
              </div>
            </div>
          ))}
        </div>
      )}
      <button onClick={() => setH2h([{ id: uid(), obtenusA: "", obtenusB: "", home: null, butsA: "", butsB: "", date: "" }, ...h2h])} style={{ ...addRowStyle(), marginTop: 0 }}>
        <Plus size={13} /> Ajouter un match
      </button>

      {stats && stats.n !== undefined && (
        <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim, display: "flex", flexDirection: "column", gap: 4 }}>
          <div>Calculé sur <b style={{ color: C.text }}>{stats.n}</b> confrontation{stats.n > 1 ? "s" : ""} (corners)</div>
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

      {stats && stats.buts && (
        <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontFamily: FONT_MONO, fontSize: 11.5, color: C.dim, display: "flex", flexDirection: "column", gap: 4 }}>
          <div>Calculé sur <b style={{ color: C.text }}>{stats.buts.n}</b> confrontation{stats.buts.n > 1 ? "s" : ""} (buts)</div>
          <div>
            total brute <b style={{ color: C.text }}>{stats.buts.moyenneTotal.toFixed(2)}</b> · pondérée récente{" "}
            <b style={{ color: C.text }}>{stats.buts.moyennePondereeTotal.toFixed(2)}</b> · volatilité{" "}
            <b style={{ color: C.text }}>±{stats.buts.volatiliteTotal.toFixed(2)}</b>
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <span style={{ color: C.teamA }}>{teamAName || "A"} : {stats.buts.moyenneA.toFixed(2)} (pond. {stats.buts.moyennePondereeA.toFixed(2)})</span>
            <span style={{ color: C.teamB }}>{teamBName || "B"} : {stats.buts.moyenneB.toFixed(2)} (pond. {stats.buts.moyennePondereeB.toFixed(2)})</span>
          </div>
          {(stats.buts.whenAHome || stats.buts.whenBHome) && (
            <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 2, paddingTop: 5, display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 9.5, color: C.faint, fontFamily: FONT_BODY }}>
                split domicile/extérieur (l'avantage du terrain compte, contrairement aux corners regroupés ci-dessus) :
              </span>
              {stats.buts.whenAHome && (
                <span>
                  quand <span style={{ color: C.teamA }}>{teamAName || "A"}</span> reçoit ({stats.buts.whenAHome.n}) : total{" "}
                  <b style={{ color: C.text }}>{stats.buts.whenAHome.moyenneTotal.toFixed(2)}</b> ({stats.buts.whenAHome.moyenneA.toFixed(2)}-{stats.buts.whenAHome.moyenneB.toFixed(2)})
                </span>
              )}
              {stats.buts.whenBHome && (
                <span>
                  quand <span style={{ color: C.teamB }}>{teamBName || "B"}</span> reçoit ({stats.buts.whenBHome.n}) : total{" "}
                  <b style={{ color: C.text }}>{stats.buts.whenBHome.moyenneTotal.toFixed(2)}</b> ({stats.buts.whenBHome.moyenneA.toFixed(2)}-{stats.buts.whenBHome.moyenneB.toFixed(2)})
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {stats && stats.moyennePondereeTotal !== undefined && seasonProj && (
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
  const filterMatches = (team) => ({ ...team, matches: applyMatchFilters(team) });
  const effA = pickVenueStats(filterMatches(teamA), "D");
  const effB = pickVenueStats(filterMatches(teamB), "E");
  // stats tous lieux confondus (pas de filtre domicile/extérieur) — pour le panneau
  // "Buts (match complet) — tous lieux confondus", en complément du panneau existant
  // qui croise domicile (équipe A) / extérieur (équipe B)
  const statsATotal = computeHistoryStats(filterMatches(teamA).matches, 0.25, !!teamA.useAdvanced) || {};
  const statsBTotal = computeHistoryStats(filterMatches(teamB).matches, 0.25, !!teamB.useAdvanced) || {};

  // Base multi-équipes pour la moyenne de ligue (voir lib/leagueStats.js) — dès qu'une
  // équipe a des stats buts exploitables, on les enregistre sous sa ligue dominante.
  // Best-effort, silencieux : ne bloque jamais le rendu si le stockage échoue.
  useEffect(() => {
    const ligue = dominantLigue(teamA.matches);
    if (ligue && teamA.nom && statsATotal.vndButs) {
      saveTeamLeagueStats(ligue, teamA.nom, statsATotal);
    }
  }, [teamA.matches, teamA.nom]);
  useEffect(() => {
    const ligue = dominantLigue(teamB.matches);
    if (ligue && teamB.nom && statsBTotal.vndButs) {
      saveTeamLeagueStats(ligue, teamB.nom, statsBTotal);
    }
  }, [teamB.matches, teamB.nom]);

  // Moyenne de ligue affichée en référence dans le panneau "tous lieux confondus" — on
  // prend la ligue dominante de l'équipe A comme ligue du duel (simplification : suppose
  // que les deux équipes comparées jouent dans la même compétition, ce qui est le cas
  // normal pour un pari sur un match entre elles).
  const [leagueAvg, setLeagueAvg] = useState(null);
  useEffect(() => {
    const ligue = dominantLigue(teamA.matches) || dominantLigue(teamB.matches);
    let cancelled = false;
    if (!ligue) {
      setLeagueAvg(null);
      return;
    }
    getLeagueAverage(ligue).then((avg) => {
      if (!cancelled) setLeagueAvg(avg);
    });
    return () => {
      cancelled = true;
    };
  }, [teamA.matches, teamB.matches]);

  const proj = projection(num(effA.obtenus), num(effB.concedes), num(effB.obtenus), num(effA.concedes));
  const matchLabel = `${teamA.nom || "Équipe A"} vs ${teamB.nom || "Équipe B"}`;

  // Convergence buts : le favori désigné par la projection domicile/extérieur est-il le
  // même que celui désigné par la projection tous lieux confondus ? Passé aux deux
  // panneaux Buts ci-dessous comme un check de convergence de plus (symétrique : sert
  // aussi bien au panneau venue qu'au panneau global, puisque c'est juste "ces deux
  // lectures sont-elles d'accord").
  const favoriButs = (sA, sB) => {
    if (!sA || !sB) return null;
    const p = projection(sA.moyObtenus, sB.moyConcedes, sB.moyObtenus, sA.moyConcedes);
    if (p.projA === p.projB) return null;
    return p.projA > p.projB ? "A" : "B";
  };
  const favoriButsVenue = favoriButs(effA.butsSeries, effB.butsSeries);
  const favoriButsGlobal = favoriButs(statsATotal.butsSeries, statsBTotal.butsSeries);
  const butsGlobalVenueAgree = favoriButsVenue && favoriButsGlobal ? favoriButsVenue === favoriButsGlobal : null;

  // xG : mêmes calculs croisés que pour les buts (favori venue vs global), plus les deux
  // métriques dérivées spécifiques au xG — avantage à la finition (buts marqués EWMA −
  // xG créés EWMA) et xG par tir (qualité moyenne des occasions, nécessite les tirs
  // saisis). Tout est optionnel : si le xG n'a pas été saisi pour une équipe, ces valeurs
  // restent null et le panneau xG ne s'affiche simplement pas pour elle.
  const favoriXgVenue = favoriButs(effA.xGSeries, effB.xGSeries);
  const favoriXgGlobal = favoriButs(statsATotal.xGSeries, statsBTotal.xGSeries);
  const xgGlobalVenueAgree = favoriXgVenue && favoriXgGlobal ? favoriXgVenue === favoriXgGlobal : null;

  const finishingEdge = (butsSeries, xgSeries) =>
    butsSeries && xgSeries && butsSeries.ewmaObtenus !== null && xgSeries.ewmaObtenus !== null
      ? butsSeries.ewmaObtenus - xgSeries.ewmaObtenus
      : null;
  const perShot = (xgSeries, shotsSeries) =>
    xgSeries && shotsSeries && shotsSeries.moyObtenus > 0 ? xgSeries.moyObtenus / shotsSeries.moyObtenus : null;

  const xgFinishVenueA = finishingEdge(effA.butsSeries, effA.xGSeries);
  const xgFinishVenueB = finishingEdge(effB.butsSeries, effB.xGSeries);
  const xgPerShotVenueA = perShot(effA.xGSeries, effA.tirsSeries);
  const xgPerShotVenueB = perShot(effB.xGSeries, effB.tirsSeries);
  const xgFinishGlobalA = finishingEdge(statsATotal.butsSeries, statsATotal.xGSeries);
  const xgFinishGlobalB = finishingEdge(statsBTotal.butsSeries, statsBTotal.xGSeries);
  const xgPerShotGlobalA = perShot(statsATotal.xGSeries, statsATotal.tirsSeries);
  const xgPerShotGlobalB = perShot(statsBTotal.xGSeries, statsBTotal.tirsSeries);

  // Taux Over/Under RÉEL par équipe (fréquence empirique, pas une moyenne) — calculé sur
  // deux lignes : 2.5 fixe (standard) et la ligne la plus proche de la projection du
  // match (pour comparer la fréquence réelle à CE QUE LE MODÈLE PROJETTE précisément,
  // pas une ligne arbitraire qui pourrait être hors sujet). Nécessite les matchs bruts
  // de chaque équipe, contrairement au reste du panneau qui ne travaille que sur les
  // séries déjà agrégées.
  const teamAVenueMatches = filterMatches(teamA).matches.filter((m) => m.lieu === "D");
  const teamBVenueMatches = filterMatches(teamB).matches.filter((m) => m.lieu === "E");
  const teamAAllMatches = filterMatches(teamA).matches;
  const teamBAllMatches = filterMatches(teamB).matches;
  const teamAForVenueOU = teamAVenueMatches.length >= 3 ? teamAVenueMatches : teamAAllMatches;
  const teamBForVenueOU = teamBVenueMatches.length >= 3 ? teamBVenueMatches : teamBAllMatches;

  const butsProjVenue = effA.butsSeries && effB.butsSeries
    ? projection(effA.butsSeries.moyObtenus, effB.butsSeries.moyConcedes, effB.butsSeries.moyObtenus, effA.butsSeries.moyConcedes)
    : null;
  const butsProjGlobal = statsATotal.butsSeries && statsBTotal.butsSeries
    ? projection(statsATotal.butsSeries.moyObtenus, statsBTotal.butsSeries.moyConcedes, statsBTotal.butsSeries.moyObtenus, statsATotal.butsSeries.moyConcedes)
    : null;
  const ligneVenue = butsProjVenue ? nearestHalfLine(butsProjVenue.total) : null;
  const ligneGlobal = butsProjGlobal ? nearestHalfLine(butsProjGlobal.total) : null;

  // Même logique que la projection de buts, mais sur le VOLUME d'attaques dangereuses —
  // sert à la fois au panneau "Attaques dangereuses" existant et au nouvel axe de menace
  // ci-dessous (winProbMenaceVenue / winProbMenaceGlobal), qui pondère ce volume par le taux de conversion réel.
  const attDangProjVenue = effA.attDangSeries && effB.attDangSeries
    ? projection(effA.attDangSeries.moyObtenus, effB.attDangSeries.moyConcedes, effB.attDangSeries.moyObtenus, effA.attDangSeries.moyConcedes)
    : null;
  const attDangProjGlobal = statsATotal.attDangSeries && statsBTotal.attDangSeries
    ? projection(statsATotal.attDangSeries.moyObtenus, statsBTotal.attDangSeries.moyConcedes, statsBTotal.attDangSeries.moyObtenus, statsATotal.attDangSeries.moyConcedes)
    : null;

  const ouDynVenueA = ligneVenue !== null ? computeOverUnder(teamAForVenueOU, "butsObtenus", "butsConcedes", ligneVenue) : null;
  const ouDynVenueB = ligneVenue !== null ? computeOverUnder(teamBForVenueOU, "butsObtenus", "butsConcedes", ligneVenue) : null;
  const ouDynGlobalA = ligneGlobal !== null ? computeOverUnder(teamAAllMatches, "butsObtenus", "butsConcedes", ligneGlobal) : null;
  const ouDynGlobalB = ligneGlobal !== null ? computeOverUnder(teamBAllMatches, "butsObtenus", "butsConcedes", ligneGlobal) : null;

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

  // Probabilité de victoire normalisée (1X2) — voir le commentaire au-dessus de
  // combineWinProbs pour le détail.
  //
  // Domicile/extérieur VS tous lieux confondus : plutôt que de choisir l'un des deux
  // contextes (et jeter l'autre), chaque critère (Buts, Attaques dangereuses, Forme) est
  // calculé UNE FOIS par contexte, et les deux versions sont injectées séparément dans la
  // moyenne pondérée — exactement comme le reste de l'app affiche déjà les deux panneaux
  // (domicile/extérieur ET tous lieux confondus) côte à côte avec un contrôle de
  // convergence, plutôt que de n'en garder qu'un. Si les deux contextes sont d'accord, le
  // résultat combiné est stable ; s'ils divergent, le résultat final se retrouve
  // naturellement entre les deux plutôt que de trancher arbitrairement pour l'un.
  // Un contexte manquant (ex. pas encore assez de matchs à domicile) est simplement
  // absent de la moyenne, qui se renormalise sur ce qui reste (comme les autres axes).
  const winProbH2h = computeH2hWinProb(h2h);

  const winProbPoissonVenue = butsProjVenue ? computePoissonMatch(butsProjVenue.projA, butsProjVenue.projB) : null;
  const winProbPoissonGlobal = butsProjGlobal ? computePoissonMatch(butsProjGlobal.projA, butsProjGlobal.projB) : null;

  const winProbRcVenueA = butsProjVenue && effA.butsSeries
    ? computeRatioCumule({ projSide: butsProjVenue.projA, projOther: butsProjVenue.projB, ewma: effA.butsSeries.ewma, vol: effA.butsSeries.volatilite, part: effA.butsSeries.part })
    : null;
  const winProbRcVenueB = butsProjVenue && effB.butsSeries
    ? computeRatioCumule({ projSide: butsProjVenue.projB, projOther: butsProjVenue.projA, ewma: effB.butsSeries.ewma, vol: effB.butsSeries.volatilite, part: effB.butsSeries.part })
    : null;
  const winProbFormeVenue = computeFormeProb(winProbRcVenueA, winProbRcVenueB, winProbPoissonVenue ? winProbPoissonVenue.pDraw : null);

  const winProbRcGlobalA = butsProjGlobal && statsATotal.butsSeries
    ? computeRatioCumule({ projSide: butsProjGlobal.projA, projOther: butsProjGlobal.projB, ewma: statsATotal.butsSeries.ewma, vol: statsATotal.butsSeries.volatilite, part: statsATotal.butsSeries.part })
    : null;
  const winProbRcGlobalB = butsProjGlobal && statsBTotal.butsSeries
    ? computeRatioCumule({ projSide: butsProjGlobal.projB, projOther: butsProjGlobal.projA, ewma: statsBTotal.butsSeries.ewma, vol: statsBTotal.butsSeries.volatilite, part: statsBTotal.butsSeries.part })
    : null;
  const winProbFormeGlobal = computeFormeProb(winProbRcGlobalA, winProbRcGlobalB, winProbPoissonGlobal ? winProbPoissonGlobal.pDraw : null);

  // Axe "Menace" (attaques dangereuses) — le volume brut d'attaques dangereuses compte
  // même sans concrétisation (comme demandé), mais est pondéré par le taux de conversion
  // réel de chaque équipe (buts marqués / attaque dangereuse créée) pour donner un "volume
  // de danger pondéré par l'efficacité" comparable à une projection de buts. Repasse par
  // le même modèle Poisson que l'axe Buts, avec son propre nul (indépendant, pas calé sur
  // l'axe Buts) puisque volume × conversion est une vraie estimation de buts attendus.
  // Comme pour Buts/Forme ci-dessus, calculé séparément pour chaque contexte
  // (domicile/extérieur et tous lieux confondus) plutôt que de choisir l'un des deux.
  //
  // Taux de conversion RÉGULARISÉ (shrinkage vers la moyenne commune aux 2 équipes,
  // pondérée par le nombre de matchs, PROPRE À CHAQUE CONTEXTE) — un ratio brut buts/
  // attaque dangereuse sur 3-6 matchs (cas courant) est extrêmement bruyant : un seul
  // match atypique peut le multiplier ou diviser par 2. PRIOR_WEIGHT_MATCHES = poids de
  // la moyenne commune, en "matchs équivalents".
  const PRIOR_WEIGHT_MATCHES = 6;
  const shrinkConv = (butsSeriesA, attDangSA, butsSeriesB, attDangSB) => {
    const poolButsA = butsSeriesA ? butsSeriesA.moyObtenus * (butsSeriesA.n || 0) : 0;
    const poolButsB = butsSeriesB ? butsSeriesB.moyObtenus * (butsSeriesB.n || 0) : 0;
    const poolAttA = attDangSA ? attDangSA.moyObtenus * (attDangSA.n || 0) : 0;
    const poolAttB = attDangSB ? attDangSB.moyObtenus * (attDangSB.n || 0) : 0;
    const poolConv = poolAttA + poolAttB > 0 ? (poolButsA + poolButsB) / (poolAttA + poolAttB) : null;
    const one = (butsSeries, attDangSeries) => {
      if (!butsSeries || !attDangSeries || !attDangSeries.moyObtenus || poolConv === null) return null;
      const n = attDangSeries.n || 0;
      const raw = butsSeries.moyObtenus / attDangSeries.moyObtenus;
      return { conv: (n * raw + PRIOR_WEIGHT_MATCHES * poolConv) / (n + PRIOR_WEIGHT_MATCHES), raw, n };
    };
    return { a: one(butsSeriesA, attDangSA), b: one(butsSeriesB, attDangSB) };
  };

  const convVenue = shrinkConv(effA.butsSeries, effA.attDangSeries, effB.butsSeries, effB.attDangSeries);
  const menaceVenueA = attDangProjVenue && convVenue.a ? attDangProjVenue.projA * convVenue.a.conv : null;
  const menaceVenueB = attDangProjVenue && convVenue.b ? attDangProjVenue.projB * convVenue.b.conv : null;
  const winProbMenaceVenue = menaceVenueA !== null && menaceVenueB !== null ? computePoissonMatch(menaceVenueA, menaceVenueB) : null;

  const convGlobal = shrinkConv(statsATotal.butsSeries, statsATotal.attDangSeries, statsBTotal.butsSeries, statsBTotal.attDangSeries);
  const menaceGlobalA = attDangProjGlobal && convGlobal.a ? attDangProjGlobal.projA * convGlobal.a.conv : null;
  const menaceGlobalB = attDangProjGlobal && convGlobal.b ? attDangProjGlobal.projB * convGlobal.b.conv : null;
  const winProbMenaceGlobal = menaceGlobalA !== null && menaceGlobalB !== null ? computePoissonMatch(menaceGlobalA, menaceGlobalB) : null;

  // Affichage du taux de conversion : celui du contexte qui a le plus de matchs (le plus
  // fiable des deux), à titre indicatif seulement — les DEUX contextes contribuent déjà
  // séparément au calcul ci-dessus, ce chiffre est juste ce qu'on montre dans le petit
  // visuel "buts par attaque dangereuse".
  const convDisplayA = (convVenue.a?.n || 0) >= (convGlobal.a?.n || 0) ? convVenue.a : convGlobal.a;
  const convDisplayB = (convVenue.b?.n || 0) >= (convGlobal.b?.n || 0) ? convVenue.b : convGlobal.b;
  const convAttDangA = convDisplayA ? convDisplayA.conv : null;
  const convAttDangB = convDisplayB ? convDisplayB.conv : null;

  const winProbCombined = combineWinProbs({
    h2h: winProbH2h,
    poissonVenue: winProbPoissonVenue,
    poissonGlobal: winProbPoissonGlobal,
    menaceVenue: winProbMenaceVenue,
    menaceGlobal: winProbMenaceGlobal,
    formeVenue: winProbFormeVenue,
    formeGlobal: winProbFormeGlobal,
  });


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
      <WinProbabilitySection
        h2h={winProbH2h}
        poissonVenue={winProbPoissonVenue}
        poissonGlobal={winProbPoissonGlobal}
        menaceVenue={winProbMenaceVenue}
        menaceGlobal={winProbMenaceGlobal}
        formeVenue={winProbFormeVenue}
        formeGlobal={winProbFormeGlobal}
        combined={winProbCombined}
        convAttDangA={convAttDangA}
        convAttDangB={convAttDangB}
        convNA={convDisplayA ? convDisplayA.n : null}
        convNB={convDisplayB ? convDisplayB.n : null}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
      />

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
        crossVenueAgree={butsGlobalVenueAgree}
        vndA={effA.vndButs}
        vndB={effB.vndButs}
        ouFixedA={effA.ouButs25}
        ouFixedB={effB.ouButs25}
        ouDynamicA={ouDynVenueA}
        ouDynamicB={ouDynVenueB}
        ppgA={effA.ppgButs}
        ppgB={effB.ppgButs}
        csA={effA.csButs}
        csB={effB.csButs}
        bttsA={effA.bttsButs}
        bttsB={effB.bttsButs}
        attDangA={effA.attDangSeries}
        attDangB={effB.attDangSeries}
        leagueAvg={leagueAvg}
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
        crossVenueAgree={butsGlobalVenueAgree}
        vndA={statsATotal.vndButs}
        vndB={statsBTotal.vndButs}
        ouFixedA={statsATotal.ouButs25}
        ouFixedB={statsBTotal.ouButs25}
        ouDynamicA={ouDynGlobalA}
        ouDynamicB={ouDynGlobalB}
        ppgA={statsATotal.ppgButs}
        ppgB={statsBTotal.ppgButs}
        csA={statsATotal.csButs}
        csB={statsBTotal.csButs}
        bttsA={statsATotal.bttsButs}
        bttsB={statsBTotal.bttsButs}
        attDangA={statsATotal.attDangSeries}
        attDangB={statsBTotal.attDangSeries}
        leagueAvg={leagueAvg}
      />

      <SecondaryStatPanel
        label="xG (Expected Goals)"
        unit="xG"
        seriesA={effA.xGSeries}
        seriesB={effB.xGSeries}
        sourceA={effA.source}
        sourceB={effB.source}
        teamAName={teamA.nom}
        teamBName={teamB.nom}
        showRatioVerdict
        showFormLabels
        showXgExtras
        crossVenueAgree={xgGlobalVenueAgree}
        xgFinishA={xgFinishVenueA}
        xgFinishB={xgFinishVenueB}
        xgPerShotA={xgPerShotVenueA}
        xgPerShotB={xgPerShotVenueB}
      />

      <SecondaryStatPanel
        label="xG (Expected Goals) — tous lieux confondus"
        unit="xG"
        seriesA={statsATotal.xGSeries}
        seriesB={statsBTotal.xGSeries}
        sourceA="tous lieux confondus"
        sourceB="tous lieux confondus"
        teamAName={teamA.nom}
        teamBName={teamB.nom}
        showRatioVerdict
        showFormLabels
        showXgExtras
        crossVenueAgree={xgGlobalVenueAgree}
        xgFinishA={xgFinishGlobalA}
        xgFinishB={xgFinishGlobalB}
        xgPerShotA={xgPerShotGlobalA}
        xgPerShotB={xgPerShotGlobalB}
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

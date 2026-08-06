import * as pdfjsLib from "pdfjs-dist";
// Vite résout ce chemin vers l'URL finale du worker après build — pas besoin de le
// copier manuellement dans public/.
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/* pdf.js renvoie le texte d'une page comme une liste de fragments avec leurs
   coordonnées, PAS déjà organisés en lignes. On reconstruit les lignes en regroupant
   les fragments dont la position verticale (Y) est proche — c'est ce qui permet ensuite
   au parser TotalCorner (qui repère la ligne juste avant chaque match) de fonctionner
   normalement, comme s'il lisait un copier-coller classique. */
async function extractPageText(page) {
  const content = await page.getTextContent();
  const lines = [];
  let currentLine = [];
  let lastY = null;
  content.items.forEach((item) => {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      lines.push(currentLine.join(" "));
      currentLine = [];
    }
    currentLine.push(item.str);
    lastY = y;
  });
  if (currentLine.length) lines.push(currentLine.join(" "));
  return lines.join("\n");
}

/* Extrait tout le texte d'un fichier PDF (File API), page par page, dans l'ordre.
   Retourne un texte unique, séparé par des sauts de ligne doubles entre les pages —
   directement exploitable par parseTotalCornerBlock, exactement comme un copier-coller
   Xodo classique. */
export async function extractPdfText(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    pageTexts.push(await extractPageText(page));
    if (onProgress) onProgress(i, pdf.numPages);
  }
  return pageTexts.join("\n\n");
}

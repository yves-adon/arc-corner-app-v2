// Proxy côté serveur vers l'API publique ClubElo (http://api.clubelo.com).
// Version optimisée pour les noms complexes avec slashs ou accents (ex: Bodø/Glimt)

export async function handler(event) {
  let team = event.queryStringParameters && event.queryStringParameters.team;

  if (!team) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "Paramètre 'team' manquant, ex. ?team=Bodo/Glimt",
    };
  }

  try {
    // 1. Remplacement des caractères accentués scandinaves/européens fréquents
    team = team.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // Supprime les accents standards
    team = team.replace(/ø/g, "o").replace(/Ø/g, "O");          // Gère le ø spécifique
    team = team.replace(/æ/g, "ae").replace(/Æ/g, "AE");
    team = team.replace(/å/g, "a").replace(/Å/g, "A");

    // 2. Nettoyage des séparateurs : supprime les slashes (/), tirets, espaces et caractères spéciaux
    // "Bodø/Glimt" ou "Bodo / Glimt" devient "BodoGlimt"
    team = team.replace(/[\s\/\-\_\.\,\'\’]/g, ""); 

    // CORRECTION : Ajout du sous-domaine indispensable 'api.'
    const url = `http://api.clubelo.com/${team}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3"
      }
    });

    if (!res.ok) {
      throw new Error(`ClubElo a répondu avec un statut ${res.status} pour le club nettoyé en '${team}'`);
    }

    const text = await res.text();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
      body: text,
    };
  } catch (e) {
    console.error("Erreur proxy ClubElo:", e.message);

    return {
      statusCode: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: `Erreur en contactant ClubElo — réessaie dans un instant. (Détail: ${e.message})`,
    };
  }
}

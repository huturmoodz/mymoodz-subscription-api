// core/kits/composition.js
// Lecture et contrôle d'une composition « variantId:qty,variantId:qty ».
// Le serveur ne fait JAMAIS confiance au navigateur : tout est revérifié ici.

const { config, isBoxVariant } = require('./config');

/** "556…789:2,556…557:2" -> Map(variantId -> qty) ; ignore les entrées vides ou mal formées */
function parseComposition(str) {
  const out = new Map();
  String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [rawId, rawQty] = pair.split(':');
      const id = String(rawId || '').trim();
      const qty = Number(rawQty);
      if (!/^\d+$/.test(id) || !Number.isInteger(qty) || qty <= 0) return;
      out.set(id, (out.get(id) || 0) + qty);
    });
  return out;
}

function stringifyComposition(map) {
  return [...map.entries()]
    .filter(([, q]) => q > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, q]) => `${id}:${q}`)
    .join(',');
}

const totalOf = (map) => [...map.values()].reduce((s, q) => s + q, 0);

/**
 * Vérifie qu'une composition est acceptable pour un total attendu.
 * @returns {{ok: true, map: Map} | {ok: false, reason: string}}
 */
function validateComposition(map, expectedTotal) {
  if (!(map instanceof Map) || map.size === 0) return { ok: false, reason: 'composition_vide' };
  for (const id of map.keys()) {
    if (!isBoxVariant(id)) return { ok: false, reason: `saveur_inconnue:${id}` };
  }
  const total = totalOf(map);
  if (total !== expectedTotal) return { ok: false, reason: `total_${total}_attendu_${expectedTotal}` };
  return { ok: true, map };
}

/** Multiplie une composition « par unité » par une quantité de parent. */
function scale(map, factor) {
  const out = new Map();
  for (const [id, q] of map) out.set(id, q * factor);
  return out;
}

/**
 * Ramène une composition à un nouveau total en gardant les proportions
 * (utile quand un abonné passe de 1 à 2 mois dans l'espace Seal).
 */
function rescale(map, newTotal) {
  const oldTotal = totalOf(map);
  if (!oldTotal) return new Map([[config.defaultBoxVariantId, newTotal]]);
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const out = new Map();
  let used = 0;
  for (const [id, q] of entries) {
    const v = Math.floor((q * newTotal) / oldTotal);
    out.set(id, v);
    used += v;
  }
  let i = 0;
  while (used < newTotal) {
    const id = entries[i % entries.length][0];
    out.set(id, out.get(id) + 1);
    used++;
    i++;
  }
  for (const [id, q] of out) if (q <= 0) out.delete(id);
  return out;
}

/** Différence entre l'état voulu et l'état actuel : { add: Map, remove: Map } en quantités. */
function diff(wanted, current) {
  const add = new Map();
  const remove = new Map();
  const ids = new Set([...wanted.keys(), ...current.keys()]);
  for (const id of ids) {
    const d = (wanted.get(id) || 0) - (current.get(id) || 0);
    if (d > 0) add.set(id, d);
    if (d < 0) remove.set(id, -d);
  }
  return { add, remove };
}

const describe = (map) =>
  [...map.entries()].map(([id, q]) => `${q} × ${(config.boxes[id] || {}).label || id}`).join(' · ');

module.exports = { parseComposition, stringifyComposition, totalOf, validateComposition, scale, rescale, diff, describe };

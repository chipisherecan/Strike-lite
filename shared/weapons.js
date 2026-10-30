// Weapon and equipment stats (roughly modelled on CS2 values).
// speed = movement speed multiplier, rate = seconds between shots,
// spread/moveSpread/airSpread in radians, recoil = degrees of view kick per shot.

export const WEAPONS = {
  knife: { name: 'Knife', slot: 3, price: 0, damage: 40, heavy: 65, rate: 0.45, heavyRate: 1.0, range: 2.2, speed: 1.0, reward: 1500, melee: true },
  glock: { name: 'Glock-18', slot: 2, team: 'T', price: 200, damage: 30, rate: 0.15, mag: 20, reserve: 120, reload: 2.2, auto: false, armorPen: 0.47, rangeMod: 0.85, spread: 0.008, moveSpread: 0.03, recoil: 1.6, speed: 0.96, reward: 300 },
  usp: { name: 'USP-S', slot: 2, team: 'CT', price: 200, damage: 35, rate: 0.17, mag: 12, reserve: 24, reload: 2.2, auto: false, armorPen: 0.505, rangeMod: 0.91, spread: 0.005, moveSpread: 0.028, recoil: 1.8, speed: 0.96, reward: 300 },
  p250: { name: 'P250', slot: 2, price: 300, damage: 38, rate: 0.15, mag: 13, reserve: 26, reload: 2.2, auto: false, armorPen: 0.64, rangeMod: 0.85, spread: 0.008, moveSpread: 0.03, recoil: 2.2, speed: 0.96, reward: 300 },
  deagle: { name: 'Desert Eagle', slot: 2, price: 700, damage: 63, rate: 0.225, mag: 7, reserve: 35, reload: 2.2, auto: false, armorPen: 0.93, rangeMod: 0.81, spread: 0.006, moveSpread: 0.07, recoil: 5.5, speed: 0.92, reward: 300 },
  mac10: { name: 'MAC-10', slot: 1, team: 'T', price: 1050, damage: 29, rate: 0.075, mag: 30, reserve: 100, reload: 2.6, auto: true, armorPen: 0.575, rangeMod: 0.8, spread: 0.012, moveSpread: 0.018, recoil: 0.8, speed: 0.96, reward: 600 },
  mp9: { name: 'MP9', slot: 1, team: 'CT', price: 1250, damage: 26, rate: 0.07, mag: 30, reserve: 120, reload: 2.1, auto: true, armorPen: 0.6, rangeMod: 0.87, spread: 0.011, moveSpread: 0.017, recoil: 0.75, speed: 0.96, reward: 600 },
  galil: { name: 'Galil AR', slot: 1, team: 'T', price: 1800, damage: 30, rate: 0.09, mag: 35, reserve: 90, reload: 2.9, auto: true, armorPen: 0.775, rangeMod: 0.98, spread: 0.006, moveSpread: 0.09, recoil: 1.0, speed: 0.86, reward: 300 },
  famas: { name: 'FAMAS', slot: 1, team: 'CT', price: 2050, damage: 30, rate: 0.09, mag: 25, reserve: 90, reload: 3.3, auto: true, armorPen: 0.7, rangeMod: 0.96, spread: 0.006, moveSpread: 0.09, recoil: 0.95, speed: 0.88, reward: 300 },
  ak47: { name: 'AK-47', slot: 1, team: 'T', price: 2700, damage: 36, rate: 0.1, mag: 30, reserve: 90, reload: 2.5, auto: true, armorPen: 0.775, rangeMod: 0.98, spread: 0.004, moveSpread: 0.11, recoil: 1.15, speed: 0.86, reward: 300 },
  m4a4: { name: 'M4A4', slot: 1, team: 'CT', price: 3100, damage: 33, rate: 0.09, mag: 30, reserve: 90, reload: 3.1, auto: true, armorPen: 0.7, rangeMod: 0.97, spread: 0.004, moveSpread: 0.1, recoil: 1.0, speed: 0.9, reward: 300 },
  awp: { name: 'AWP', slot: 1, price: 4750, damage: 115, rate: 1.46, mag: 5, reserve: 30, reload: 3.7, auto: false, armorPen: 0.975, rangeMod: 0.99, spread: 0.002, moveSpread: 0.2, unscoped: 0.08, recoil: 3, speed: 0.8, scoped: 0.6, reward: 100, scope: true },
  he: { name: 'HE Grenade', slot: 4, price: 300, nade: true, speed: 1.0, reward: 300 },
  flash: { name: 'Flashbang', slot: 4, price: 200, nade: true, speed: 1.0, max: 2 },
  smoke: { name: 'Smoke Grenade', slot: 4, price: 300, nade: true, speed: 1.0 },
  bomb: { name: 'C4 Explosive', slot: 5, price: 0, speed: 1.0 },
};

export const EQUIPMENT = {
  vest: { name: 'Kevlar Vest', price: 650 },
  vesthelm: { name: 'Kevlar + Helmet', price: 1000 },
  kit: { name: 'Defuse Kit', price: 400, team: 'CT' },
};

export const BUY_MENU = [
  { cat: 'Pistols', items: ['glock', 'usp', 'p250', 'deagle'] },
  { cat: 'SMGs', items: ['mac10', 'mp9'] },
  { cat: 'Rifles', items: ['galil', 'famas', 'ak47', 'm4a4', 'awp'] },
  { cat: 'Gear', items: ['vest', 'vesthelm', 'kit'] },
  { cat: 'Grenades', items: ['he', 'flash', 'smoke'] },
];

export const HIT_MULT = { head: 4, chest: 1, stomach: 1.25, legs: 0.75 };

export function itemInfo(id) { return WEAPONS[id] || EQUIPMENT[id]; }

// Spray pattern: offsets in degrees [yaw, pitch] for shot index i. Climbs up then sways side to side.
export function recoilOffset(w, i) {
  const k = w.recoil;
  const up = Math.min(i, 9) * k + Math.max(0, i - 9) * k * 0.15;
  const side = i < 4 ? 0 : Math.sin((i - 4) * 0.45) * k * 2.2 * (i < 14 ? 1 : -1);
  return [side, up];
}

// Damage after hit group, distance falloff and armour.
export function computeDamage(weaponId, group, dist, victim, heavy) {
  const w = WEAPONS[weaponId];
  if (!w) return { hp: 0, armor: 0 };
  if (w.melee) return { hp: heavy ? w.heavy : w.damage, armor: 0 };
  let dmg = w.damage * Math.pow(w.rangeMod, dist / 12.7) * (HIT_MULT[group] || 1);
  let armorLoss = 0;
  const armored = victim.armor > 0 && group !== 'legs' && (group !== 'head' || victim.helmet);
  if (armored) {
    const reduced = dmg * w.armorPen;
    armorLoss = Math.min(victim.armor, (dmg - reduced) * 0.5);
    dmg = reduced;
  }
  return { hp: Math.round(dmg), armor: Math.round(armorLoss) };
}

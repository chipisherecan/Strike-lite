// Weathered Mediterranean surfaces and wall details for Mirage, painted in code at 1024 px (no image files).
export const HD_SIZE = 1024;
const S = HD_SIZE;
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function blotches(g, r, n, cols, rMin, rMax, aMax) {
  for (let i = 0; i < n; i++) {
    const x = r() * S, y = r() * S, rad = rMin + r() * (rMax - rMin), c = cols[Math.floor(r() * cols.length)], a = r() * aMax;
    // drawn wrapped so the texture still tiles
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      gr.addColorStop(0, rgba(c, a)); gr.addColorStop(1, rgba(c, 0));
      g.fillStyle = gr; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    }
  }
}

function grain(g, r, amount) {
  const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n)); d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n)); d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

function cracks(g, r, n, col = 'rgba(60,40,25,0.4)') {
  g.strokeStyle = col;
  for (let i = 0; i < n; i++) {
    let x = r() * S, y = r() * S;
    g.lineWidth = 0.6 + r() * 1.2; g.beginPath(); g.moveTo(x, y);
    for (let k = 0, m = 3 + r() * 9; k < m; k++) { x += (r() - 0.5) * 50; y += 8 + r() * 30; g.lineTo(x, y); }
    g.stroke();
  }
}

function peel(g, r, n, under) {
  // irregular patches where the paint has come off, with a dark lip
  for (let i = 0; i < n; i++) {
    const cx = r() * S, cy = r() * S, R = 18 + r() * 70, pts = [];
    for (let a = 0; a < 10; a++) { const q = R * (0.75 + r() * 0.45); pts.push([cx + Math.cos(a / 10 * 6.283) * q * 1.7, cy + Math.sin(a / 10 * 6.283) * q * 0.75]); }
    // smooth outline through the midpoints, so it reads as flaked paint rather than a spiky shape
    g.beginPath();
    pts.forEach((p, k) => { const q = pts[(k + 1) % pts.length], mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2; if (k) g.quadraticCurveTo(p[0], p[1], mx, my); else g.moveTo(mx, my); });
    g.closePath();
    g.strokeStyle = 'rgba(50,35,25,0.4)'; g.lineWidth = 2.5; g.stroke();
    g.fillStyle = rgba(under, 0.95); g.fill();
  }
}

function plaster(g, r, c, { peelCol = null, dark = [90, 62, 38], light = [255, 240, 210] } = {}) {
  g.fillStyle = rgba(c, 1); g.fillRect(0, 0, S, S);
  blotches(g, r, 90, [dark, light], 40, 240, 0.2);
  blotches(g, r, 260, [dark, light], 6, 40, 0.15);
  if (peelCol) { peel(g, r, 4, peelCol); blotches(g, r, 40, [dark], 10, 60, 0.15); }
  cracks(g, r, 14);
  for (let i = 0; i < 26; i++) { // drip stains
    const x = r() * S, y = r() * S, h = 70 + r() * 300, gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, rgba(dark, 0.12)); gr.addColorStop(1, rgba(dark, 0));
    g.fillStyle = gr; g.fillRect(x, y, 3 + r() * 16, h);
  }
  grain(g, r, 13);
}

function courses(g, r, rows, cols, stones, mortar, mw, jag = 0) {
  const bh = S / rows;
  g.fillStyle = mortar; g.fillRect(0, 0, S, S);
  for (let row = 0; row < rows; row++) {
    let x = (row % 2) * (S / cols) * 0.5 - S / cols;
    while (x < S) {
      const w = (S / cols) * (1 - jag / 2 + r() * jag);
      g.fillStyle = stones[Math.floor(r() * stones.length)];
      g.fillRect(x + mw, row * bh + mw, w - mw * 2, bh - mw * 2);
      g.fillStyle = 'rgba(255,245,220,0.14)'; g.fillRect(x + mw, row * bh + mw, w - mw * 2, 2);
      g.fillStyle = 'rgba(50,30,15,0.18)'; g.fillRect(x + mw, row * bh + bh - mw - 2, w - mw * 2, 2);
      x += w;
    }
  }
}

function checker(g, r, n, cols, grout, gw) {
  const t = S / n;
  g.fillStyle = grout; g.fillRect(0, 0, S, S);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = cols[Math.floor(r() * cols.length)]; g.fillRect(x * t + gw, y * t + gw, t - gw * 2, t - gw * 2); }
}

const W = (g, r) => { blotches(g, r, 60, [[70, 50, 30]], 15, 110, 0.14); grain(g, r, 11); };

function cobbles(g, r, cols, size) {
  g.fillStyle = '#8e7a63'; g.fillRect(0, 0, S, S);
  const n = Math.round(S / size);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = (x + (y % 2) * 0.5) * size + (r() - 0.5) * size * 0.2, py = y * size + (r() - 0.5) * size * 0.2;
    const col = cols[Math.floor(r() * cols.length)], rx = size * (0.5 + r() * 0.1), ry = size * (0.44 + r() * 0.1), rot = r();
    for (const ox of [0, -S]) for (const oy of [0, -S]) {
      g.fillStyle = col;
      g.beginPath(); g.ellipse(px + ox + size / 2, py + oy + size / 2, rx, ry, rot, 0, 6.283); g.fill();
    }
  }
}

export const HD = {
  plaster_ochre(g, r) { plaster(g, r, [214, 166, 96]); },
  plaster_cream(g, r) { plaster(g, r, [214, 198, 170], { dark: [105, 90, 72] }); },
  plaster_red(g, r) { plaster(g, r, [184, 88, 62], { peelCol: [205, 184, 150] }); },
  plaster_blue(g, r) { plaster(g, r, [86, 136, 200], { peelCol: [212, 196, 160], dark: [36, 58, 100] }); },
  plaster_pink(g, r) { plaster(g, r, [214, 170, 148]); },
  plaster_green(g, r) { plaster(g, r, [190, 202, 150], { dark: [90, 100, 66] }); },
  sandstone(g, r) { courses(g, r, 7, 4, ['#d2b386', '#c8a878', '#dcbe92', '#bf9f70', '#d6b98c'], '#9e845f', 4, 0.5); W(g, r); },
  brick_pale(g, r) { courses(g, r, 22, 8, ['#d8c6aa', '#d0bb9e', '#e0cfb5', '#c9b394'], '#a8967c', 2.5, 0.15); W(g, r); },
  flagstone(g, r) { courses(g, r, 5, 3, ['#d6bc92', '#cdb287', '#dcc49c', '#c6aa7e'], '#9d8762', 3, 0.5); W(g, r); },
  cobble_warm(g, r) { cobbles(g, r, ['#b89f83', '#a98f74', '#c4ab8e', '#9d8469', '#b2967a'], 62); W(g, r); },
  tile_cream(g, r) { checker(g, r, 4, ['#e6d6b8', '#dfceb0', '#ebdcc0'], '#b3a182', 2); W(g, r); },
  tile_terra(g, r) { checker(g, r, 6, ['#bd8058', '#b47650', '#c58a62', '#ab6e4a'], '#8d6a4c', 3); W(g, r); },
  tile_white(g, r) { checker(g, r, 10, ['#dfe6e2', '#d6dedb', '#e7ece9'], '#9eaaa8', 2); W(g, r); },
  wood_old(g, r) {
    const n = 7, h = S / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = ['#8d7358', '#7f664d', '#967c60', '#755e47'][Math.floor(r() * 4)]; g.fillRect(0, i * h, S, h);
      for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '45,30,18' : '200,175,145'},${r() * 0.16})`; g.fillRect(r() * S, i * h + r() * h, 120 + r() * 500, 1 + r() * 2); }
      g.fillStyle = 'rgba(25,15,8,0.75)'; g.fillRect(0, i * h, S, 4);
    }
    grain(g, r, 10);
  },
  crate_hd(g, r) {
    g.fillStyle = '#b5935f'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 9; i++) { g.fillStyle = ['#c1a06c', '#b08c58', '#a98452'][i % 3]; g.fillRect(0, i * S / 9 + 3, S, S / 9 - 6); }
    g.fillStyle = '#7f6946'; g.fillRect(0, 0, S, 90); g.fillRect(0, S - 90, S, 90); g.fillRect(0, 0, 90, S); g.fillRect(S - 90, 0, 90, S);
    g.save(); g.translate(S / 2, S / 2); g.rotate(0.78); g.fillRect(-S, -38, S * 2, 76); g.restore();
    g.fillStyle = 'rgba(214,106,38,0.95)'; g.fillRect(90, 90, 70, 18); g.fillRect(S - 160, S - 108, 70, 18);
    W(g, r);
  },
  carton(g, r) {
    const n = 2, t = S / n;
    g.fillStyle = '#6d5335'; g.fillRect(0, 0, S, S);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = ['#c9a56f', '#c09b65', '#d0ad78'][Math.floor(r() * 3)]; g.fillRect(x * t + 5, y * t + 5, t - 10, t - 10);
      g.fillStyle = 'rgba(232,212,170,0.75)'; g.fillRect(x * t + t * 0.43, y * t + 5, t * 0.14, t - 10);
    }
    W(g, r);
  },
  ceil_plain(g, r) { plaster(g, r, [176, 186, 160], { dark: [70, 80, 60] }); },
};

// ------------------------------------------------------------- wall details (transparent background)
const frame = (g, x, y, w, h, c = '#b7a585') => { g.fillStyle = c; g.fillRect(x - 24, y - 24, w + 48, h + 48); };
function archPath(g, x, y, w, h) { g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y + w / 2); g.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); g.lineTo(x + w, y + h); g.closePath(); }
function slats(g, x, y, w, h, c) {
  g.fillStyle = c; g.fillRect(x, y, w, h);
  for (let yy = y; yy < y + h; yy += 20) { g.fillStyle = 'rgba(25,18,12,0.55)'; g.fillRect(x, yy, w, 6); g.fillStyle = 'rgba(255,240,215,0.14)'; g.fillRect(x, yy + 6, w, 3); }
  g.fillStyle = 'rgba(25,18,12,0.8)'; g.fillRect(x + w / 2 - 4, y, 8, h);
}
function archedShutter(g, x, y, w, h, c) {
  g.save(); archPath(g, x, y, w, h); g.fillStyle = '#b7a585'; g.lineWidth = 44; g.strokeStyle = '#b7a585'; g.stroke(); g.clip(); slats(g, x, y, w, h, c); g.restore();
}
function graffiti(g, ch, rot, arrow) {
  g.save(); g.translate(S / 2, S / 2); g.rotate(rot);
  g.fillStyle = 'rgba(172,28,20,0.92)'; g.font = 'bold 660px Impact, Arial Black, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(ch, 0, arrow ? -90 : 30);
  if (arrow) { g.lineWidth = 46; g.strokeStyle = g.fillStyle; g.lineCap = 'round'; g.beginPath(); g.moveTo(-170, 330); g.lineTo(190, 400); g.moveTo(110, 300); g.lineTo(200, 400); g.lineTo(90, 470); g.stroke(); }
  g.restore();
}

export const DETAIL = {
  frond(g) {
    // pale so vertex colour tints it; a central rib with feathered leaflets
    g.strokeStyle = '#e8e8d8'; g.lineCap = 'round';
    for (let y = 0; y < 1000; y += 13) {
      const t = y / 1000, reach = 500 * Math.sin(Math.min(1, t * 1.25 + 0.08) * Math.PI * 0.62 + 0.2) * (1 - t * 0.55);
      g.lineWidth = 10;
      for (const s of [-1, 1]) { g.beginPath(); g.moveTo(512, y); g.lineTo(512 + s * reach, y + 95); g.stroke(); }
    }
    g.lineWidth = 16; g.beginPath(); g.moveTo(512, 0); g.lineTo(512, S); g.stroke();
  },
  win_arch(g) { archedShutter(g, 300, 120, 424, 780, '#8c7d68'); },
  win_arch2(g) { archedShutter(g, 110, 120, 340, 780, '#8f8676'); archedShutter(g, 574, 120, 340, 780, '#8f8676'); },
  win_rect(g) { frame(g, 200, 150, 624, 720); slats(g, 200, 150, 624, 720, '#7d5f43'); },
  win_blue(g) { frame(g, 200, 150, 624, 720, '#d2c5a8'); slats(g, 200, 150, 624, 720, '#94663f'); g.fillStyle = 'rgba(70,110,170,0.95)'; g.fillRect(150, 80, 724, 70); },
  win_grille(g) {
    g.save(); archPath(g, 230, 90, 564, 840); g.fillStyle = '#c5dbe2'; g.fill(); g.lineWidth = 40; g.strokeStyle = '#a8957a'; g.stroke(); g.clip();
    g.fillStyle = '#3a4b35'; g.fillRect(230, 560, 564, 370); g.strokeStyle = '#1c1815'; g.lineWidth = 11;
    for (let x = 290; x < 794; x += 72) { g.beginPath(); g.moveTo(x, 90); g.lineTo(x, 930); g.stroke(); }
    for (let y = 340; y < 930; y += 150) { g.beginPath(); g.moveTo(230, y); g.lineTo(794, y); g.stroke(); }
    g.restore();
  },
  door_grey(g) { frame(g, 262, 60, 500, 964, '#a59a84'); g.fillStyle = '#918876'; g.fillRect(262, 60, 500, 964); g.fillStyle = 'rgba(30,25,20,0.65)'; g.fillRect(506, 60, 12, 964); for (const x of [300, 548]) for (const y of [110, 400, 690]) { g.strokeStyle = 'rgba(30,25,20,0.5)'; g.lineWidth = 7; g.strokeRect(x, y, 175, 250); } },
  door_wood(g) { g.save(); archPath(g, 290, 40, 444, 984); g.lineWidth = 40; g.strokeStyle = '#a58d6a'; g.stroke(); g.fillStyle = '#6f573e'; g.fill(); g.clip(); for (let x = 290; x < 734; x += 56) { g.fillStyle = 'rgba(25,15,8,0.6)'; g.fillRect(x, 0, 7, S); } g.fillStyle = '#222'; g.fillRect(460, 330, 104, 110); g.restore(); },
  arch_dark(g) { g.save(); archPath(g, 110, 60, 804, 964); g.lineWidth = 58; g.strokeStyle = '#c3a982'; g.stroke(); g.fillStyle = '#6b4f31'; g.fill(); g.restore(); },
  carpet(g, r) {
    g.fillStyle = '#a6372c'; g.fillRect(250, 20, 524, 984);
    g.strokeStyle = '#e4c79a'; g.lineWidth = 15; g.strokeRect(285, 55, 454, 914); g.strokeStyle = '#3a2520'; g.lineWidth = 9; g.strokeRect(315, 85, 394, 854);
    g.fillStyle = '#e4c79a';
    for (let y = 150; y < 900; y += 130) { g.beginPath(); g.moveTo(512, y - 58); g.lineTo(630, y); g.lineTo(512, y + 58); g.lineTo(394, y); g.closePath(); g.fill(); g.fillStyle = g.fillStyle === '#e4c79a' ? '#3a2520' : '#e4c79a'; }
    void r;
  },
  lamp_wall(g) { g.fillStyle = '#26211c'; g.fillRect(490, 110, 44, 180); g.beginPath(); g.moveTo(410, 290); g.lineTo(614, 290); g.lineTo(574, 680); g.lineTo(450, 680); g.closePath(); g.fill(); g.fillStyle = '#d9b873'; g.fillRect(460, 340, 104, 280); },
  lamp_green(g) { g.fillStyle = '#26332a'; g.fillRect(496, 40, 32, 400); g.fillStyle = '#4a7d5e'; g.beginPath(); g.moveTo(330, 700); g.quadraticCurveTo(512, 300, 694, 700); g.closePath(); g.fill(); },
  ivy(g, r) { for (let i = 0; i < 1300; i++) { const x = 90 + r() * 844, f = (x - 512) / 422, y = r() * r() * (980 - Math.abs(f) * 620); g.fillStyle = ['#51752e', '#3f6126', '#6b8f3b', '#2f4e20'][Math.floor(r() * 4)]; g.beginPath(); g.ellipse(x, y, 13 + r() * 16, 8 + r() * 10, r() * 3, 0, 6.283); g.fill(); } },
  graf_a(g) { graffiti(g, 'A', -0.06, false); },
  graf_b(g) { graffiti(g, 'B', 0.05, true); },
  poster(g) { g.fillStyle = '#66b03d'; g.fillRect(250, 40, 524, 944); g.fillStyle = '#f2f4e6'; g.font = 'bold 170px Arial'; g.textAlign = 'center'; g.fillText('eau', 512, 300); g.beginPath(); g.arc(512, 620, 170, 0, 6.283); g.fill(); },
  board(g) { g.fillStyle = '#7d6a50'; for (let i = 0; i < 7; i++) { g.save(); g.translate(512, 110 + i * 130); g.rotate((i % 2 ? -1 : 1) * 0.05); g.fillRect(-470, -55, 940, 104); g.restore(); } },
};

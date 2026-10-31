// Mirage, drawn by hand. Every floor is one outline read off a zoomed CS2 radar (x = east, z = south, in metres), at a height
// from public player-position data. Floors are perfectly flat or a single even slope, so nothing is left to radar noise.
// Heights are game units (the numbers getpos shows); Y() converts them to metres.
// Walls are generated along each outline, wherever the outline doesn't touch another floor.
export const Y = (u) => (u + 369) * 0.0254 + 0.5;

const F = 'flagstone', C = 'cobble_warm', TT = 'tile_terra', TC = 'tile_cream', TW = 'tile_white';
const TUNNEL_TOP = 3.05;   // underpass headroom

// [name, height, outline, options]. roof: metres to the ceiling. over: floor above the underpass. thin: a deck with air under it.
// slope: [axis, from, to, height at from, height at to]. stairs (rects only): [x1,z1,x2,z2, axis, height at low edge, height at high edge].
const flat = (name, u, pts, o = {}) => ({ name, u, pts, tex: F, ...o });
export const FLOORS = [
  // ---------- B
  flat('B west', -169, [[2, 12], [3.4, 10.8], [9, 11], [17.2, 11], [17.2, 8.6], [32, 8.6], [32, 11.2], [39.3, 11.2], [39.7, 17.2], [44, 17.2], [44, 23.3], [32, 23.2], [32, 32], [8.5, 32], [8.5, 27], [9.6, 26], [9.5, 23], [2.8, 23]]),
  flat('B over underpass', -169, [[44, 17.2], [47, 17.2], [47, 23.3], [44, 23.3]], { over: true }),
  flat('B platform', -161, [[14, 14], [23, 14], [23, 23.5], [14, 23.5]], { noWalls: true }),
  flat('B plat', -127, [[10, 4], [17.2, 3.4], [17.2, 8.6], [9.6, 8.6]]),
  flat('B plat slope', -127, [[9.6, 8.6], [17.2, 8.6], [17.2, 11], [9, 11]], { slope: ['z', 8.6, 11, -127, -169] }),
  flat('B apartments', -49, [[20, 3], [21.2, 3], [21.2, 4.8], [22.4, 4.8], [22.4, 3.4], [25.6, 3.2], [26, 2.5], [28, 2.5], [32.3, 2.7], [32.6, 4], [32.7, 8.6], [22.4, 8.6], [22.4, 7.4], [21.2, 7.4], [21.2, 8.6], [20, 8.6]], { tex: TT, roof: 3.2 }),
  flat('North room', -53, [[32.6, 4], [45.6, 4], [45.6, 7.5], [40, 7.5], [40, 8.6], [32.7, 8.6]], { tex: TT, roof: 3.2 }),
  // ---------- Market
  flat('Market', -169, [[9.7, 32], [12.5, 32], [12.5, 36.7], [16.7, 36.7], [16.7, 32.5], [20.7, 32.5], [20.7, 32], [23.2, 32], [23.2, 34.5], [25, 37.8], [31.3, 37.8], [31.3, 43.6], [28.2, 43.6], [20.3, 43.4], [20.3, 42.4], [17, 42.4], [17, 43.4], [9.7, 43.4]], { tex: TW, roof: 3.4 }),
  // ---------- Short and catwalk
  flat('Short', -169, [[42, 26.3], [45, 26.3], [45, 29.8], [42, 29.3]], { tex: C }),
  flat('Short over underpass', -169, [[45, 26.3], [47, 26.3], [47, 28.8], [46.2, 28.8], [46.2, 31], [45, 31]], { tex: C, over: true }),
  flat('Catwalk', -57, [[39.6, 26.3], [42, 26.3], [42, 29.3], [44.8, 30], [44.8, 31], [42.4, 31], [42.4, 32], [39.6, 32]]),
  // ---------- Top mid and the north side of mid
  flat('Top mid', -169, [[47, 17.2], [52.3, 17.2], [52.3, 26.4], [52, 29], [54.4, 33.5], [70, 33.5], [75, 30.5], [75, 26], [81.6, 26], [82.4, 27.5], [84.2, 27.5], [84.2, 49.6], [60.6, 49.6], [60.6, 46], [72, 46], [72, 38.5], [47.3, 38.5], [47.3, 34], [47, 33]], { tex: C }),
  flat('Mid', -265, [[43, 41], [47.3, 41], [47.3, 38.5], [64, 38.5], [64, 46], [43, 46]], { tex: C }),
  // ---------- Window and CT side
  flat('Window room', -169, [[38.4, 38.5], [43, 38.5], [43, 46], [42.5, 46], [42.5, 55.6], [41, 55.6], [41, 56.4], [38.3, 56.4], [38.3, 55.6], [33.2, 55.6], [33.2, 46.5], [36.2, 46.5], [36.2, 48.7], [38.4, 48.7], [38.4, 46.7], [40, 46.7], [40, 45], [38.4, 45]], { tex: TT, roof: 3.3 }),
  flat('To market', -169, [[26.5, 44.3], [28.2, 44.3], [28.2, 43.6], [31, 43.6], [31, 44.3], [33.8, 44.3], [33.8, 46.5], [33.2, 46.5], [33.2, 47], [26.5, 47]]),
  flat('CT ramp', -169, [[26.5, 47], [33.2, 47], [33.2, 55.7], [32.4, 58], [26.5, 58]], { slope: ['z', 47, 58, -169, -265] }),
  flat('CT', -265, [[26.5, 58], [32.4, 58], [32.4, 64.5], [35.4, 64.5], [35.4, 67], [33.5, 67], [33.5, 73], [34, 73], [34, 78.6], [35.7, 79.6], [35.7, 82], [35, 82], [35, 88.5], [32.4, 87.6], [30.5, 87.3], [27.6, 80], [26.3, 77.5], [18.3, 77.5], [18.3, 70], [25, 70], [26.5, 68]]),
  flat('CT to A', -169, [[35, 82], [44, 82], [44, 91.6], [35, 88.5]], { slope: ['x', 35, 44, -265, -169] }),
  // ---------- Jungle and connector
  flat('Jungle', -169, [[37.5, 56.4], [41.7, 56.4], [41.7, 58], [45.8, 58], [45.8, 59.6], [47.8, 59.6], [47.8, 58], [52.1, 58], [52.1, 57.3], [55.5, 57.3], [55.5, 58], [58.5, 58], [58.5, 60], [57, 60], [57, 62.7], [57.4, 66], [50.2, 66], [48, 64.7], [41.7, 64.7], [41.7, 63], [40, 63], [40, 64.7], [37.5, 64.7]], { tex: C }),
  flat('Connector', -169, [[49.6, 46.7], [52, 46.7], [52, 55.2], [55.5, 55.2], [55.5, 46.7], [56.3, 46.7], [56.3, 50], [57.9, 50], [57.9, 57.3], [49.6, 57.3], [49.6, 54.2], [50.7, 54.2], [50.7, 52.6], [49.6, 52.6]], { tex: TT }),
  // ---------- A site: sunken square with two low steps around it
  flat('A low', -181, [[50.2, 70], [56, 70], [63.5, 80.3], [50.2, 86.6]]),
  flat('A step north', -175, [[50.2, 66], [57.4, 66], [59, 67.6], [56, 70], [50.2, 70]]),
  flat('A step east', -175, [[59, 67.6], [66.3, 80.5], [63.5, 80.3], [56, 70]]),
  flat('A step south', -175, [[63.5, 80.3], [66.3, 80.5], [50.2, 89], [50.2, 86.6]]),
  flat('A back east', -167, [[66.3, 80.5], [68.4, 81], [68.4, 86.8], [60.9, 86.8], [60.3, 85.4], [59.1, 86], [50.2, 91], [50.2, 89]]),
  flat('A back west', -169, [[44, 82], [45.5, 82.6], [48, 82.6], [50.2, 81.4], [50.2, 91], [48, 91], [48.6, 93], [44, 91.6]]),
  // A ramp, which also runs under the palace deck
  flat('A ramp', -174, [[60.8, 62.7], [61.2, 61.5], [64.3, 61.4], [66.4, 61], [72, 61], [75.9, 60.7], [77.5, 60.3], [83, 60.3], [83, 64.5], [78.5, 64.5], [78.5, 69.7], [77.5, 69.7], [77.5, 66.5], [75.8, 66.5], [75.8, 69.7], [72.5, 69.7], [72.5, 73.6], [75, 73.6], [75, 78.7], [73.2, 78.7], [73.2, 81], [68.4, 81], [66.3, 80.5], [59, 67.6], [60, 67.5], [61, 66.5]], { slope: ['x', 78.5, 66, -177, -169] }),
  // ---------- T side
  flat('T spawn', -165, [[98.4, 21.5], [106, 21.5], [105.7, 22.7], [107.5, 23], [107.5, 27.3], [108.4, 27.4], [108.4, 30.7], [107.6, 30.7], [107.6, 35.7], [98.4, 35.7]]),
  flat('Terrace', -165, [[102.8, 35.7], [107, 35.7], [107, 63.5], [96.8, 63.5], [96.8, 64], [93.5, 64], [93.5, 60], [103.3, 60], [103.3, 57.7], [102.8, 57.7]]),
  flat('Lane', -165, [[98.4, 35.7], [102.8, 35.7], [102.8, 47], [98.4, 47]], { tex: C, slope: ['z', 35.7, 47, -165, -197] }),
  flat('Lane lower', -197, [[98.4, 47], [102.8, 47], [102.8, 50], [98.4, 50.1]], { tex: C, slope: ['z', 47, 50, -197, -264] }),
  flat('Low lane', -264, [[88.3, 51], [97.7, 51], [98.4, 50.1], [102.8, 50], [102.8, 57.7], [100.4, 57.7], [100.4, 55.8], [90, 55.8], [90, 69.7], [83, 69.7], [83, 64.5], [84.5, 64.5], [84.8, 60], [85.2, 55.4], [88.3, 55.4]], { tex: C }),
  flat('Lane ledge', -109, [[90, 55.8], [100.4, 55.8], [100.4, 57.7], [92, 57.7], [92, 69.7], [90, 69.7]]),
  flat('Lane box', -122, [[85.2, 53.4], [88.3, 53.4], [88.3, 55.4], [85.2, 55.4]], { noWalls: true, tex: 'crate_hd' }),
  flat('Side alley', -255, [[74.4, 7.8], [82.7, 7.4], [82.7, 10.7], [93, 10.7], [93, 7.4], [97.2, 7.4], [100, 8.2], [100.4, 11.7], [106, 11.7], [106, 15], [102, 15], [102, 21.5], [98.7, 21.5], [98.7, 18.9], [97, 18.8], [97, 16.8], [95, 14.5], [92, 14.4], [88, 14.5], [85, 14.4], [84, 14.6], [81.5, 17.4], [81.5, 20], [74.5, 20], [74.6, 17.5], [77, 17.3], [76.8, 16], [76.2, 10.7]], { tex: 'sand' }),
  flat('Apps platform', -122, [[82.7, 7.4], [87, 7.4], [87, 10.7], [82.7, 10.7]], { tex: 'wood_old' }),
  // ---------- T apartments and the corridor over to B
  flat('T apartments', -122, [[67.3, 2.4], [73.5, 2.4], [73.5, 3.3], [74.2, 3.3], [74.2, 2.4], [82, 2.4], [82, 2.1], [88, 2.1], [88, 6.3], [86.8, 6.3], [86.8, 7.4], [84.8, 7.4], [84.8, 6.3], [80, 6.2], [80, 5.2], [74.2, 5.2], [74.2, 6.2], [67.3, 6.2]], { tex: TT, roof: 3.2 }),
  flat('Apartments', -47, [[58.4, 2], [61.6, 2], [61.6, 6.2], [67.3, 6.2], [67.3, 16.6], [64, 16.6], [64, 12.2], [49, 12.2], [49, 9], [58, 9], [58.4, 8]], { tex: TT, roof: 3.2 }),
  flat('Short top', -81, [[40, 9], [46, 9], [46, 13], [45, 13], [45, 17.2], [41.2, 17.2], [40, 15.2]], { tex: TT }),
  flat('Short top over underpass', -81, [[45, 13], [46, 13], [46, 16.5], [45, 16.5]], { tex: TT, over: true, noWalls: true }),
  // ---------- Palace
  flat('Palace', -41, [[77.5, 75], [82, 75], [82, 74.4], [85.4, 74.4], [85.4, 75], [87, 75], [87, 74.4], [90, 74.4], [90, 75], [91.7, 75], [91.7, 79.9], [97.8, 79.9], [97.8, 81.7], [98.4, 81.7], [98.4, 86.2], [90, 86.2], [90, 87.1], [82.4, 87.1], [82.4, 86], [72, 86.2], [70.8, 86.8], [70.8, 81], [73.6, 81], [73.6, 83.3], [77.6, 83.3]], { tex: TC, roof: 3.6 }),
  flat('Palace entry', -73, [[93.5, 70], [98.5, 70], [98.5, 74], [97.8, 74], [97.8, 75], [98.5, 75], [98.5, 79.9], [93, 79.9], [93, 75], [93.5, 75]], { tex: TC, roof: 3.6 }),
  flat('Palace deck', -41, [[69.4, 73.6], [75, 73.6], [75, 78.7], [73.6, 78.7], [73.6, 81], [69.4, 81]], { tex: TC, thin: true, noWalls: true }),
  // ---------- The Stairs block on A
  flat('Stairs block', -41, [[57.1, 62.7], [60.8, 62.7], [61, 66.5], [60, 67.5], [59, 67.6], [58, 67.5], [57.4, 66]], { noWalls: true, side: 'plaster_ochre' }),
];

export const STAIRS = [
  { name: 'Side alley to T spawn', r: [102, 15, 106, 21.5], axis: 'z', a: -255, b: -165 },
  { name: 'Apps ramp', r: [87, 7.4, 93, 10.7], axis: 'x', a: -122, b: -255 },
  { name: 'Alley to top mid', r: [74.5, 20, 81.5, 26], axis: 'z', a: -255, b: -169 },
  { name: 'Mid steps', r: [64, 38.5, 72, 46], axis: 'x', a: -265, b: -169 },
  { name: 'A ramp steps', r: [78.5, 64.5, 83, 69.7], axis: 'x', a: -177, b: -264 },
  { name: 'Palace stairs', r: [93.5, 64, 96.8, 70], axis: 'z', a: -168, b: -73 },
  { name: 'Palace upper', r: [91.7, 75, 93, 79.9], axis: 'x', a: -41, b: -73 },
  { name: 'Connector stairs', r: [52, 46, 55.5, 55.2], axis: 'z', a: -265, b: -169 },
  { name: 'Underpass from mid', r: [43, 34.4, 47, 41], axis: 'z', a: -369, b: -265 },
  { name: 'Underpass up to apartments', r: [47, 13, 64, 16.5], axis: 'x', a: -369, b: -47 },
  { name: 'T apartments stairs', r: [61.6, 2, 67.3, 6.2], axis: 'x', a: -47, b: -122 },
  { name: 'Corridor steps', r: [46, 9, 49, 12.2], axis: 'x', a: -81, b: -47 },
  { name: 'North room steps', r: [40, 7.5, 45.6, 9], axis: 'z', a: -53, b: -81 },
  { name: 'B apartments stairs', r: [17.2, 3.4, 20, 8.6], axis: 'x', a: -125, b: -49 },
  { name: 'Catwalk steps', r: [39.6, 32, 42.4, 38.5], axis: 'z', a: -57, b: -169 },
  { name: 'Stairs block steps', r: [57, 60, 59.6, 62.7], axis: 'z', a: -169, b: -41, noWalls: true },
];

export const TUNNEL = { pts: [[45, 13], [47, 13], [47, 34.4], [45, 34.4]], u: -369, top: TUNNEL_TOP, connects: ['Underpass from mid', 'Underpass up to apartments'],
  slabs: [[45, 23.3, 47, 26.3], [45, 31, 47, 34.4], [46, 13, 47, 17.2], [45, 16.5, 46, 17.2], [46.2, 28.8, 47, 31]] };

// Boxes and props: axis-aligned, or a rotated square for the ones sitting at an angle on the radar.
const on = (x1, z1, x2, z2, u, h, tex = 'crate_hd', up = 0) => ({ t: 'box', min: [x1, Y(u) + up, z1], max: [x2, Y(u) + up + h, z2], tex, box: true });
const solid = (x1, z1, x2, z2, y0, y1, tex) => ({ t: 'box', min: [x1, y0, z1], max: [x2, y1, z2], tex });
const turned = (cx, cz, half, ang, u, h, tex = 'crate_hd', up = 0) => {
  const pts = [0, 1, 2, 3].map((k) => { const a = ang + k * Math.PI / 2 + Math.PI / 4, r = half * Math.SQRT2; return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]; });
  return { t: 'prism', pts, bottom: Y(u) + up, top: Y(u) + up + h, tex, box: true };
};
const BLUE = { top: F, side: 'plaster_blue', bottom: 'plaster_blue' };
const FB = Y(-161);

export const EXTRA = [
  // Railing on the palace deck
  solid(69.2, 73.6, 69.4, 77.5, Y(-41), Y(-41) + 0.95, 'plaster_ochre'),
  // B apartments window wall: sill and header, so B is overlooked and can be dropped into
  solid(20, 8.3, 32.7, 8.6, Y(-49) - 0.1, Y(-49) + 0.95, BLUE),
  solid(17.2, 8.3, 32.7, 8.6, Y(-49) + 2.3, Y(-49) + 3.4, BLUE),
  // Window: a wall facing down mid with a wide hole broken through it
  solid(42.6, 38.5, 43, 46, Y(-169) - 0.1, Y(-169) + 0.85, 'plaster_pink'),
  solid(42.6, 38.5, 43, 46, Y(-169) + 2.15, Y(-169) + 3.3, 'plaster_pink'),
  solid(42.6, 38.5, 43, 40, Y(-169) + 0.85, Y(-169) + 2.15, 'plaster_pink'),
  solid(42.6, 44.5, 43, 46, Y(-169) + 0.85, Y(-169) + 2.15, 'plaster_pink'),
  solid(36.4, 51.5, 36.6, 55.6, Y(-169), Y(-169) + 3.3, 'plaster_cream'),
  // Connector and its stairs share a roof
  { t: 'box', min: [49.6, Y(-169) + 3.2, 46.4], max: [57.9, Y(-169) + 3.5, 57.3], tex: { top: F, side: 'plaster_ochre', bottom: 'wood_old' }, roof: true },
  // Underpass stairs up to the apartments are indoors
  { t: 'box', min: [47, Y(-47) + 3, 12.7], max: [64, Y(-47) + 3.3, 16.8], tex: { top: F, side: 'plaster_ochre', bottom: 'wood_old' }, roof: true },
  // Palace pillars and benches
  ...[[80.6, 80], [85.4, 80], [90, 80]].map(([x, z]) => solid(x, z, x + 1.6, z + 1.7, Y(-41), Y(-41) + 3.6, 'plaster_cream')),
  on(83, 85.2, 89, 87, -41, 0.5, 'plaster_cream'), on(83.6, 86.2, 88.4, 87, -41, 0.4, 'cloth_red', 0.5),
  on(82, 74.5, 85.3, 75.4, -41, 0.5, 'plaster_cream'), on(87.1, 74.5, 90, 75.4, -41, 0.5, 'plaster_cream'),
  // A site boxes, where the radar has them
  turned(66.2, 64.5, 1.8, 0, -174, 1.1, 'carton'), turned(66.8, 64.9, 1.2, 0, -174, 1.0, 'carton', 1.1),       // tetris
  turned(62.8, 79.2, 1.15, 0.2, -176, 1.15), turned(64.4, 78.1, 0.75, 0.75, -176, 1.0),                         // default
  turned(63.8, 83.6, 1.2, 0.3, -172, 1.1), turned(62.4, 85.4, 1.2, -0.5, -170, 1.1, 'crate_hd'),               // firebox
  turned(47.8, 88.8, 1.25, 0.25, -169, 1.25), turned(49.4, 90, 0.95, 0.1, -169, 1.05),                         // triple box
  on(45, 82.8, 47.8, 84.2, -169, 1.2),                                                                         // ninja
  turned(54.5, 78.8, 1.25, 0.6, -181, 1.1), on(55.4, 76.7, 58, 78.8, -181, 1.2),                               // sandwich boxes
  on(70.3, 70.3, 71.8, 72, -172, 1.3),
  // Mid and top mid cartons
  on(47.6, 44.5, 50.3, 45.7, -265, 1.07, 'carton'),
  turned(78.6, 40.2, 1.25, 0.78, -169, 1.1, 'carton'), turned(76.8, 43.2, 1.15, 0.78, -169, 1.1, 'carton'), on(78, 43.5, 79.9, 45.3, -169, 1.15, 'carton'),
  on(72.3, 47.8, 74.2, 49.5, -169, 1.3),
  // B site: brick corner walls with wide openings under the green tarp, boxes inside
  ...[[13.4, 13.4, 16, 13.9], [13.4, 13.4, 13.9, 16], [21, 13.4, 23.4, 13.9], [22.9, 13.4, 23.4, 16], [13.4, 23.5, 16, 24], [13.4, 21.3, 13.9, 24], [21, 23.5, 23.4, 24], [22.9, 21.3, 23.4, 24]]
    .map(([a, b, c, e]) => solid(a, b, c, e, Y(-169), FB + 3.2, 'brick_pale')),
  { t: 'box', min: [13.4, FB + 3.2, 13.4], max: [23.4, FB + 3.3, 24], tex: 'nodraw', roof: true },
  on(14.2, 14.1, 16.7, 16.5, -161, 1.2), on(20.3, 14.1, 22.8, 16.3, -161, 1.2),
  on(20.1, 20.9, 22.7, 23.2, -161, 1.25), on(20.2, 19.5, 22.5, 20.9, -161, 0.8),                                // boost boxes
  on(7.3, 16, 8.6, 18.8, -169, 0.5, 'wood_old'),                                                                // bench
  solid(32, 16.1, 33.4, 18, Y(-169), 13, 'plaster_cream'),
  turned(11.7, 7.2, 1.9, 0.2, -127, 1.1, { top: 'van', side: 'van', bottom: 'nodraw' }),                        // van
  on(30.8, 23.2, 31.8, 24.8, -169, 1.1),
  // Market shelves
  on(18, 42.4, 19.7, 43.4, -169, 1.6, 'tile_white'), on(13.5, 41.4, 17, 43, -169, 1.2, 'tile_white'),
];

export const ZONES = { A: [54, 79, 61, 85], B: [15, 15, 23, 23], T: [99, 23, 106, 35], CT: [27, 65, 33, 79] };

export const LOOK = {
  theme: { floor: F, wall: 'plaster_cream', ceil: 'wood_old', skyTop: 0x8cbbe2, skyHorizon: 0xf0ead9, fog: 0xece5d4, sun: [-0.5, 0.74, 0.46], sunColor: [1.12, 0.98, 0.78], ambient: [0.5, 0.47, 0.46] },
  ceilings: [], floors: [], boxes: [],
  // [x1,z1,x2,z2, wall material, wall top height]; the last match wins. Interiors use the ROOMS list below instead.
  paint: [
    [0, 0, 120, 102, 'plaster_cream', 12],
    [107, 10, 120, 95, 'plaster_ochre', 17],      // T spawn's long wall
    [64, 70, 104, 95, 'plaster_ochre', 17],       // palace
    [84, 36, 90, 56, 'plaster_red', 15],          // red building
    [90, 36, 99, 56, 'plaster_cream', 13],        // T spawn's corner house
    [53, 17, 76, 34, 'sandstone', 10],            // low stone wall along top mid, skyline behind it
    [58, 49, 88, 60, 'plaster_blue', 14],         // blue building at top mid
    [28, 44, 58, 66, 'plaster_pink', 11],         // jungle
    [44, 64, 51, 92, 'sandstone', 10],            // A site's west wall
    [49, 46, 59, 58, 'plaster_ochre', 11],        // connector
    [0, 0, 46, 8.6, 'plaster_blue', 13],          // B apartments
    [58, 0, 92, 12, 'plaster_ochre', 13],         // T apartments
    [39, 17, 53, 37, 'brick_pale', 10],           // catwalk and short
    [32, 23, 47, 27, 'sandstone', 10],            // arches
    [6, 32, 32, 45, 'plaster_green', 10],         // market
    [0, 10, 12, 32, 'plaster_pink', 11],          // bench side of B
  ],
};
// Rooms whose inside differs from the outside of the same wall
export const ROOMS = { Palace: 'plaster_cream', 'Palace entry': 'plaster_cream', 'B apartments': 'plaster_ochre', 'North room': 'plaster_ochre', Apartments: 'plaster_ochre', 'T apartments': 'plaster_ochre', 'Window room': 'plaster_pink' };

// Decals are cast onto the first surface in a direction from an open spot: n = -z, s = +z, e = +x, w = -x
const d = (tex, x, z, dir, u, w, h) => ({ t: 'decal', tex, x, z, dir, y: Y(u), w, h });
const roof = (y, list) => list.map(([k, x, z, ry]) => ({ t: k, x, y, z, ry }));

export const DECOR = [
  // ---------- T spawn, corner house and the long wall
  d('door_grey', 100, 44, 'w', -150, 1.8, 2.6), d('lamp_green', 100, 44, 'w', -85, 0.7, 0.9), d('win_arch2', 100, 44, 'w', -20, 2.4, 2),
  d('graf_b', 100, 38, 'w', -105, 2.2, 2.2), d('carpet', 100, 48, 'w', 0, 1.5, 3.2), d('win_rect', 100, 40, 'w', 30, 1.3, 1.5),
  d('lamp_wall', 105, 28, 'e', -105, 0.5, 0.8), d('lamp_wall', 105, 44, 'e', -105, 0.5, 0.8), d('lamp_wall', 105, 57, 'e', -105, 0.5, 0.8),
  d('win_rect', 105, 36, 'e', 40, 1, 1.5), d('win_rect', 105, 50, 'e', 40, 1, 1.5),
  d('win_arch', 92, 53, 'n', -60, 1.6, 2.4), d('win_arch', 96, 53, 'n', -60, 1.6, 2.4),
  // ---------- Top mid: stone wall with arch and ivy, blue building
  d('arch_dark', 68, 35, 'n', -120, 3, 3.5), d('ivy', 58, 35, 'n', -45, 3.2, 2.6), d('ivy', 64, 35, 'n', -45, 3.2, 2.6), d('ivy', 73, 34, 'n', -45, 3.2, 2.6),
  d('win_blue', 64, 47, 's', -60, 1.5, 1.8), d('win_blue', 68, 47, 's', -60, 1.5, 1.8), d('win_blue', 76, 47, 's', -60, 1.5, 1.8),
  d('door_wood', 71, 47, 's', -122, 1.5, 2.4), d('carpet', 80, 47, 's', -50, 1.7, 2), d('win_arch', 46, 44, 's', -170, 1.1, 1.6),
  // ---------- A site
  d('graf_a', 59, 72, 'n', -100, 2.6, 1.9), d('win_grille', 66, 84, 'e', 40, 1.5, 2.2), d('win_rect', 52, 76, 'w', -60, 1.1, 1.2),
  // ---------- Connector, jungle and window
  d('door_wood', 56, 52, 'e', -125, 1.1, 2.2), d('carpet', 45, 62, 'n', -60, 1.8, 2.4), d('board', 40, 42, 'w', -100, 1.8, 1.8),
  // ---------- Palace: arched grilled windows on the north wall, red A at the far end
  d('win_grille', 80, 78, 'n', 15, 1.5, 2.4), d('win_grille', 88, 78, 'n', 15, 1.5, 2.4), d('graf_a', 80, 78, 'w', 16, 1.3, 1.3),
  // ---------- B: apartments, arches, market
  d('win_blue', 25, 13, 'n', -100, 1.6, 1.0), d('arch_dark', 34, 20, 's', -120, 3.2, 3.5), d('arch_dark', 39, 20, 's', -120, 3.2, 3.5),
  d('ivy', 36, 13, 'n', -40, 3, 2.4), d('win_rect', 5, 18, 'w', -50, 1.2, 1.5),
  d('poster', 19, 40, 'n', -120, 0.8, 1.2), d('poster', 21, 40, 'e', -120, 0.8, 1.2), d('poster', 14, 40, 's', -120, 0.8, 1.2),
  // T apartments and B apartments interiors
  d('win_arch', 70, 4, 'n', -70, 1.1, 2), d('win_arch', 76, 4, 'n', -70, 1.1, 2), d('door_wood', 80, 4, 'n', -80, 1.2, 2.2), d('win_arch', 25, 5, 'n', 0, 1.1, 2),
  // ---------- Plants, roofs, wires, scaffolding, skyline
  ...[[47, 86], [30, 66], [34, 70], [30, 28], [6, 13]].map(([x, z]) => ({ t: 'palm2', x, z })),
  // palms rising from behind the walls, as seen over A, top mid and T spawn
  ...[[43, 70], [46, 76], [62, 27], [71, 28], [112, 12], [28, 0], [60, 94]].map(([x, z]) => ({ t: 'palm2', x, z, y: 8.5, h: 7 })),
  { t: 'tarp', x1: 13.2, z1: 13.2, x2: 23.6, z2: 24.2, y: Y(-161) + 3.35 },
  { t: 'scaffold', x: 69.4, z1: 74, z2: 80, y0: Y(-41), h: 5.5, axis: 'z' },
  ...roof(13.1, [['antenna', 96, 42, 0.4], ['dish', 94, 47, 1.0]]), ...roof(15.1, [['antenna', 87, 42, 0.1], ['dish', 86, 47, 2.4]]),
  ...roof(14.1, [['antenna', 66, 54, 0.8], ['dish', 73, 55, 0.2]]), ...roof(13.1, [['antenna', 22, 1, 2.0], ['dish', 36, 2, 1.4]]), ...roof(10.1, [['antenna', 62, 27, 0.5], ['antenna', 44, 24.8, 1.2]]),
  { t: 'wire', a: [97, 13, 41], b: [108, 17, 22] }, { t: 'wire', a: [88, 15, 38], b: [66, 14, 50] }, { t: 'wire', a: [66, 14, 52], b: [52, 10, 30] },
  { t: 'wire', a: [32, 13, 9], b: [40, 10, 25] }, { t: 'wire', a: [14, 11, 10], b: [24, 11, 30] },
  { t: 'tower', x: 36, z: 30, base: 8, h: 24, w: 7 }, { t: 'tower', x: 125, z: 84, base: 8, h: 26, w: 8 }, { t: 'tower', x: 22, z: 118, base: 4, h: 22, w: 6 },
  { t: 'tower', x: 63, z: 55, base: 8, h: 9, w: 6 }, { t: 'merlons', x1: 60, z1: 52, x2: 66, z2: 58, y: 17 },
  { t: 'skyline' },
  // Baked interior lights
  ...[[54, 52], [40, 42], [36, 50], [18, 40], [25, 40], [82, 78], [88, 78], [96, 77], [82, 84], [90, 84], [96, 84], [72, 4], [82, 4], [25, 5], [36, 6], [55, 10], [64, 10]].map(([x, z]) => ({ t: 'lamp', x, z })),
];

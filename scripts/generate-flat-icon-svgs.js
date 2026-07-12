#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'assets', 'icons');
const BODY_RADIUS = 3.55;
const TAIL_ANGLE = 20;
const SCALE = 118;
const CENTER_X = 500;
const CENTER_Y = 488;

function normalize([x, y]) {
  const length = Math.hypot(x, y);
  return [x / length, y / length];
}

function ellipsePoint(angleDegrees) {
  const angle = angleDegrees * Math.PI / 180;
  return [BODY_RADIUS * Math.cos(angle), BODY_RADIUS * Math.sin(angle)];
}

function ellipseTangent(angleDegrees) {
  const angle = angleDegrees * Math.PI / 180;
  return [-BODY_RADIUS * Math.sin(angle), BODY_RADIUS * Math.cos(angle)];
}

function rayCircleIntersection(origin, direction) {
  const [ox, oy] = origin;
  const [dx, dy] = direction;
  const a = (dx * dx + dy * dy) / (BODY_RADIUS * BODY_RADIUS);
  const b = 2 * (ox * dx + oy * dy) / (BODY_RADIUS * BODY_RADIUS);
  const c = (ox * ox + oy * oy) / (BODY_RADIUS * BODY_RADIUS) - 1;
  const discriminant = Math.max(0, b * b - 4 * a * c);
  const roots = [
    (-b - Math.sqrt(discriminant)) / (2 * a),
    (-b + Math.sqrt(discriminant)) / (2 * a),
  ].filter(value => value >= 0);
  const distance = Math.min(...roots);
  return [ox + distance * dx, oy + distance * dy];
}

function ellipseAngle([x, y]) {
  return ((Math.atan2(y / BODY_RADIUS, x / BODY_RADIUS) * 180 / Math.PI) + 360) % 360;
}

function linePoints(start, end, count) {
  const points = [];
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    points.push([
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ]);
  }
  return points;
}

function quadraticPoints(start, control, end, count) {
  const points = [];
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    const mt = 1 - t;
    points.push([
      mt * mt * start[0] + 2 * mt * t * control[0] + t * t * end[0],
      mt * mt * start[1] + 2 * mt * t * control[1] + t * t * end[1],
    ]);
  }
  return points;
}

function cubicPoints(start, control1, control2, end, count) {
  const points = [];
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    const mt = 1 - t;
    points.push([
      mt ** 3 * start[0] + 3 * mt * mt * t * control1[0] + 3 * mt * t * t * control2[0] + t ** 3 * end[0],
      mt ** 3 * start[1] + 3 * mt * mt * t * control1[1] + 3 * mt * t * t * control2[1] + t ** 3 * end[1],
    ]);
  }
  return points;
}

function bubbleOutline() {
  const fixedCorner = [-BODY_RADIUS, -BODY_RADIUS];
  const angle = TAIL_ANGLE * Math.PI / 180;
  const incomingRay = [Math.sin(angle), Math.cos(angle)];
  const outgoingRay = [Math.cos(angle), Math.sin(angle)];
  const incomingHit = rayCircleIntersection(fixedCorner, incomingRay);
  const outgoingHit = rayCircleIntersection(fixedCorner, outgoingRay);
  const incomingAngle = ellipseAngle(incomingHit);
  const outgoingAngle = ellipseAngle(outgoingHit);
  const transitionDegrees = 4;
  const incomingArcEndAngle = incomingAngle - transitionDegrees;
  const outgoingArcStartAngle = outgoingAngle + transitionDegrees;
  const incomingArcEnd = ellipsePoint(incomingArcEndAngle);
  const outgoingArcStart = ellipsePoint(outgoingArcStartAngle);

  const points = [];
  for (let degree = 0; degree < Math.floor(incomingArcEndAngle); degree += 2) {
    points.push(ellipsePoint(degree));
  }
  points.push(incomingArcEnd);

  const transitionLength = 0.28;
  const handleLength = 0.18;
  const incomingLineStart = [
    incomingHit[0] - incomingRay[0] * transitionLength,
    incomingHit[1] - incomingRay[1] * transitionLength,
  ];
  const incomingArcTangent = normalize(ellipseTangent(incomingArcEndAngle));
  points.push(...cubicPoints(
    incomingArcEnd,
    [incomingArcEnd[0] + incomingArcTangent[0] * handleLength, incomingArcEnd[1] + incomingArcTangent[1] * handleLength],
    [incomingLineStart[0] + incomingRay[0] * handleLength, incomingLineStart[1] + incomingRay[1] * handleLength],
    incomingLineStart,
    10,
  ));

  const cornerFilletDistance = 0.5;
  const cornerIn = [
    fixedCorner[0] + incomingRay[0] * cornerFilletDistance,
    fixedCorner[1] + incomingRay[1] * cornerFilletDistance,
  ];
  const cornerOut = [
    fixedCorner[0] + outgoingRay[0] * cornerFilletDistance,
    fixedCorner[1] + outgoingRay[1] * cornerFilletDistance,
  ];
  points.push(...linePoints(incomingLineStart, cornerIn, 10));
  points.push(...quadraticPoints(cornerIn, fixedCorner, cornerOut, 16));

  const outgoingLineEnd = [
    outgoingHit[0] - outgoingRay[0] * transitionLength,
    outgoingHit[1] - outgoingRay[1] * transitionLength,
  ];
  points.push(...linePoints(cornerOut, outgoingLineEnd, 10));
  const outgoingArcTangent = normalize(ellipseTangent(outgoingArcStartAngle));
  points.push(...cubicPoints(
    outgoingLineEnd,
    [outgoingLineEnd[0] + outgoingRay[0] * handleLength, outgoingLineEnd[1] + outgoingRay[1] * handleLength],
    [outgoingArcStart[0] - outgoingArcTangent[0] * handleLength, outgoingArcStart[1] - outgoingArcTangent[1] * handleLength],
    outgoingArcStart,
    10,
  ));

  for (let degree = Math.ceil(outgoingArcStartAngle) + 1; degree <= 360; degree += 2) {
    points.push(ellipsePoint(degree));
  }
  return points;
}

function svgPoint([x, y]) {
  return [CENTER_X + x * SCALE, CENTER_Y - y * SCALE];
}

function bubblePath() {
  const fixedCorner = [-BODY_RADIUS, -BODY_RADIUS];
  const angle = TAIL_ANGLE * Math.PI / 180;
  const incomingRay = [Math.sin(angle), Math.cos(angle)];
  const outgoingRay = [Math.cos(angle), Math.sin(angle)];
  const incomingHit = rayCircleIntersection(fixedCorner, incomingRay);
  const outgoingHit = rayCircleIntersection(fixedCorner, outgoingRay);
  const incomingArcEndAngle = ellipseAngle(incomingHit) - 4;
  const outgoingArcStartAngle = ellipseAngle(outgoingHit) + 4;
  const incomingArcEnd = ellipsePoint(incomingArcEndAngle);
  const outgoingArcStart = ellipsePoint(outgoingArcStartAngle);
  const transitionLength = 0.28;
  const handleLength = 0.18;
  const cornerFilletDistance = 0.5;
  const incomingLineStart = [
    incomingHit[0] - incomingRay[0] * transitionLength,
    incomingHit[1] - incomingRay[1] * transitionLength,
  ];
  const outgoingLineEnd = [
    outgoingHit[0] - outgoingRay[0] * transitionLength,
    outgoingHit[1] - outgoingRay[1] * transitionLength,
  ];
  const incomingArcTangent = normalize(ellipseTangent(incomingArcEndAngle));
  const outgoingArcTangent = normalize(ellipseTangent(outgoingArcStartAngle));
  const incomingControl1 = [
    incomingArcEnd[0] + incomingArcTangent[0] * handleLength,
    incomingArcEnd[1] + incomingArcTangent[1] * handleLength,
  ];
  const incomingControl2 = [
    incomingLineStart[0] + incomingRay[0] * handleLength,
    incomingLineStart[1] + incomingRay[1] * handleLength,
  ];
  const cornerIn = [
    fixedCorner[0] + incomingRay[0] * cornerFilletDistance,
    fixedCorner[1] + incomingRay[1] * cornerFilletDistance,
  ];
  const cornerOut = [
    fixedCorner[0] + outgoingRay[0] * cornerFilletDistance,
    fixedCorner[1] + outgoingRay[1] * cornerFilletDistance,
  ];
  const outgoingControl1 = [
    outgoingLineEnd[0] + outgoingRay[0] * handleLength,
    outgoingLineEnd[1] + outgoingRay[1] * handleLength,
  ];
  const outgoingControl2 = [
    outgoingArcStart[0] - outgoingArcTangent[0] * handleLength,
    outgoingArcStart[1] - outgoingArcTangent[1] * handleLength,
  ];

  const format = point => svgPoint(point).map(value => value.toFixed(2)).join(' ');
  const radius = (BODY_RADIUS * SCALE).toFixed(2);
  return [
    `M ${format(ellipsePoint(0))}`,
    `A ${radius} ${radius} 0 1 0 ${format(incomingArcEnd)}`,
    `C ${format(incomingControl1)} ${format(incomingControl2)} ${format(incomingLineStart)}`,
    `L ${format(cornerIn)}`,
    `Q ${format(fixedCorner)} ${format(cornerOut)}`,
    `L ${format(outgoingLineEnd)}`,
    `C ${format(outgoingControl1)} ${format(outgoingControl2)} ${format(outgoingArcStart)}`,
    `A ${radius} ${radius} 0 0 0 ${format(ellipsePoint(0))}`,
    'Z',
  ].join(' ');
}

// Purpose-built broad-centre silhouette. The lower boundary is the exact
// 180-degree counterpart of the upper boundary around (500, 500), so the
// filled mark remains centred and point-symmetric. Cubic handles are tangent
// matched at every internal join; only the two endpoints form cusps.
const REFINED_BROAD_CENTRE_PATH = `M 190 610
  C 275 535 340 365 450 390
  C 530 408 515 470 590 475
  C 665 480 750 420 810 390
  C 725 465 660 635 550 610
  C 470 592 485 530 410 525
  C 335 520 250 580 190 610
  Z`;

const STROKE_OPTIONS = [
  { id: '01-balanced', label: 'Balanced', endOffset: 64, innerOffset: 52, tension: 0.95, halfWidth: 54, taperExponent: 0.95 },
  { id: '02-long-taper', label: 'Long taper', endOffset: 64, innerOffset: 52, tension: 0.95, halfWidth: 60, taperExponent: 1.45 },
  { id: '03-flatter', label: 'Flatter', endOffset: 42, innerOffset: 34, tension: 0.95, halfWidth: 52, taperExponent: 0.95 },
  { id: '04-deeper', label: 'Deeper N', endOffset: 88, innerOffset: 72, tension: 0.92, halfWidth: 54, taperExponent: 0.95 },
  { id: '05-broad-centre', label: 'Broad centre refined', endOffset: 92, innerOffset: 72, tension: 1.0, halfWidth: 72, taperExponent: 0.72, customPath: REFINED_BROAD_CENTRE_PATH },
  { id: '06-fine-brush', label: 'Fine brush', endOffset: 62, innerOffset: 48, tension: 1.0, halfWidth: 43, taperExponent: 1.12 },
  { id: '07-taut-n', label: 'Taut N', endOffset: 72, innerOffset: 58, tension: 0.68, halfWidth: 53, taperExponent: 0.92 },
  { id: '08-soft-sweep', label: 'Soft sweep', endOffset: 56, innerOffset: 42, tension: 1.28, halfWidth: 56, taperExponent: 0.88 },
];

const palettes = {
  stable: { core: '#0866FF' },
  beta: { core: '#FF6500' },
};

function cubicPoint(start, c1, c2, end, t) {
  const mt = 1 - t;
  return [
    mt ** 3 * start[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t ** 3 * end[0],
    mt ** 3 * start[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t ** 3 * end[1],
  ];
}

function strokeKnots(option) {
  return [
    [225, 500 + option.endOffset],
    [420, 500 - option.innerOffset],
    [580, 500 + option.innerOffset],
    [775, 500 - option.endOffset],
  ];
}

function strokeSegments(option) {
  const points = strokeKnots(option);
  const virtualStart = [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]];
  const virtualEnd = [2 * points[3][0] - points[2][0], 2 * points[3][1] - points[2][1]];
  const extended = [virtualStart, ...points, virtualEnd];
  const segments = [];
  for (let index = 1; index <= 3; index += 1) {
    const previous = extended[index - 1];
    const start = extended[index];
    const end = extended[index + 1];
    const following = extended[index + 2];
    const scale = option.tension / 6;
    segments.push({
      start,
      c1: [start[0] + (end[0] - previous[0]) * scale, start[1] + (end[1] - previous[1]) * scale],
      c2: [end[0] - (following[0] - start[0]) * scale, end[1] - (following[1] - start[1]) * scale],
      end,
    });
  }
  return segments;
}

function sampleStroke(option) {
  const points = [];
  for (const segment of strokeSegments(option)) {
    for (let index = 0; index <= 48; index += 1) {
      if (points.length && index === 0) continue;
      points.push(cubicPoint(segment.start, segment.c1, segment.c2, segment.end, index / 48));
    }
  }
  return points;
}

function strokeShapePath(option) {
  const centreline = sampleStroke(option);
  const upper = [];
  const lower = [];
  for (let index = 0; index < centreline.length; index += 1) {
    const previous = centreline[Math.max(0, index - 1)];
    const next = centreline[Math.min(centreline.length - 1, index + 1)];
    const [tx, ty] = normalize([next[0] - previous[0], next[1] - previous[1]]);
    const normal = [-ty, tx];
    const t = index / (centreline.length - 1);
    const halfWidth = option.halfWidth * Math.pow(Math.max(0, Math.sin(Math.PI * t)), option.taperExponent);
    upper.push([centreline[index][0] + normal[0] * halfWidth, centreline[index][1] + normal[1] * halfWidth]);
    lower.push([centreline[index][0] - normal[0] * halfWidth, centreline[index][1] - normal[1] * halfWidth]);
  }
  return [...upper, ...lower.reverse()]
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ') + ' Z';
}

function buildSvg(palette, option = STROKE_OPTIONS[0]) {
  const strokePath = option.customPath || strokeShapePath(option);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 1000" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="${bubblePath()}" fill="${palette.core}"/>
  <path d="${strokePath}" fill="#FFFFFF"/>
</svg>
`;
}

for (const [variant, palette] of Object.entries(palettes)) {
  const filename = variant === 'stable' ? 'messenger-icon.svg' : 'messenger-icon-beta.svg';
  fs.writeFileSync(path.join(ICONS_DIR, filename), buildSvg(palette, STROKE_OPTIONS[4]));
  console.log(`Generated ${filename}`);
}

if (process.argv.includes('--options')) {
  const reviewDir = path.join(ICONS_DIR, 'reviews', 'stroke-options');
  fs.mkdirSync(reviewDir, { recursive: true });
  for (const option of STROKE_OPTIONS) {
    for (const [variant, palette] of Object.entries(palettes)) {
      fs.writeFileSync(path.join(reviewDir, `${option.id}-${variant}.svg`), buildSvg(palette, option));
    }
  }
  fs.writeFileSync(path.join(reviewDir, 'options.json'), JSON.stringify(STROKE_OPTIONS, null, 2));
  console.log(`Generated ${STROKE_OPTIONS.length} flat stroke options`);
}

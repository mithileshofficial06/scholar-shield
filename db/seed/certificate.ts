/**
 * Synthetic income-certificate renderer.
 *
 * SAFETY POSTURE
 * --------------
 * These are documents that imitate a government form, so two things are baked
 * into every render and are not optional:
 *
 *   1. A diagonal SYNTHETIC watermark across the page.
 *   2. A header that says SIMULATED, and a seal that carries no real emblem.
 *
 * The point is that a file leaving this repo cannot function as a forgery. The
 * watermark is drawn identically on genuine, tampered, and control variants, so
 * it is a constant across the corpus and cannot confound the ELA false-positive
 * measurement — every image carries it, so no comparison between them turns on it.
 *
 * WHY A REAL RASTER AND NOT A FIXTURE STRING
 * ------------------------------------------
 * OCR accuracy and ELA both depend on pixels: glyph shapes, JPEG block
 * boundaries, the local statistics around an edited region. A JSON fixture
 * standing in for a document would make the Week 4 metrics meaningless.
 */

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { SeedApplication } from './types.js';

export const DOC_WIDTH = 900;
export const DOC_HEIGHT = 1180;

/** Where the income figure sits — the tamper path needs to find it later. */
export interface FieldBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedCertificate {
  png: Buffer;
  /** Bounding box of the declared-income value, for the tamper pipeline. */
  incomeBox: FieldBox;
  incomeWordsBox: FieldBox;
}

const INK = '#1a1a1a';
const FAINT = '#5b5b5b';
const RULE = '#9a9a9a';

/** Indian numbering: 1,78,000 rather than 178,000. */
export function formatINR(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  const o = ONES[n % 10]!;
  return o ? `${t} ${o}` : t;
}

/**
 * Amount in words, Indian style. Present because a real certificate carries one,
 * and a tamperer who edits only the figure leaves the words contradicting it —
 * a cross-field inconsistency the OCR stage can surface later.
 */
export function amountInWords(value: number): string {
  if (value === 0) return 'Zero Rupees Only';

  const parts: string[] = [];
  const lakh = Math.floor(value / 100_000);
  const thousand = Math.floor((value % 100_000) / 1_000);
  const hundred = Math.floor((value % 1_000) / 100);
  const rest = value % 100;

  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred > 0) parts.push(`${ONES[hundred]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));

  return `${parts.join(' ')} Rupees Only`;
}

function text(
  ctx: SKRSContext2D,
  value: string,
  x: number,
  y: number,
  font: string,
  colour = INK,
): number {
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.fillText(value, x, y);
  return ctx.measureText(value).width;
}

function rule(ctx: SKRSContext2D, x1: number, y: number, x2: number, colour = RULE): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

/** Diagonal SYNTHETIC watermark. Identical on every variant — see file header. */
function watermark(ctx: SKRSContext2D): void {
  ctx.save();
  ctx.translate(DOC_WIDTH / 2, DOC_HEIGHT / 2);
  ctx.rotate(-Math.PI / 6);
  ctx.textAlign = 'center';
  ctx.font = 'bold 74px Arial';
  ctx.fillStyle = 'rgba(190, 60, 60, 0.13)';
  ctx.fillText('SYNTHETIC', 0, -30);
  ctx.font = 'bold 30px Arial';
  ctx.fillText('NOT A GOVERNMENT DOCUMENT', 0, 26);
  ctx.restore();
  ctx.textAlign = 'left';
}

function seal(ctx: SKRSContext2D, cx: number, cy: number, office: string): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(40, 70, 130, 0.55)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 58, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 48, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(40, 70, 130, 0.62)';
  ctx.textAlign = 'center';
  ctx.font = 'bold 11px Arial';
  ctx.fillText('SPECIMEN', cx, cy - 8);
  ctx.font = '8px Arial';
  // Office name only — no emblem, no state insignia.
  const short = office.replace(/ Taluk Office$/, '').slice(0, 22);
  ctx.fillText(short.toUpperCase(), cx, cy + 6);
  ctx.fillText('SIMULATED SEAL', cx, cy + 18);
  ctx.restore();
  ctx.textAlign = 'left';
}

export function renderCertificate(app: SeedApplication): RenderedCertificate {
  const canvas = createCanvas(DOC_WIDTH, DOC_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Paper
  ctx.fillStyle = '#fbfaf6';
  ctx.fillRect(0, 0, DOC_WIDTH, DOC_HEIGHT);

  // Outer frame
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, DOC_WIDTH - 56, DOC_HEIGHT - 56);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 36, DOC_WIDTH - 72, DOC_HEIGHT - 72);

  watermark(ctx);

  const left = 70;
  const right = DOC_WIDTH - 70;
  let y = 92;

  ctx.textAlign = 'center';
  text(ctx, 'TAMIL NADU e-DISTRICT — SIMULATED', DOC_WIDTH / 2, y, 'bold 13px Arial', FAINT);
  y += 34;
  text(ctx, 'INCOME CERTIFICATE', DOC_WIDTH / 2, y, 'bold 30px Arial');
  y += 20;
  text(ctx, '(Synthetic specimen — generated for software testing)', DOC_WIDTH / 2, y, '11px Arial', FAINT);
  ctx.textAlign = 'left';

  y += 26;
  rule(ctx, left, y, right, '#3a3a3a');

  y += 34;
  text(ctx, `Certificate No.  ${app.certificateId}`, left, y, 'bold 13px Arial');
  ctx.textAlign = 'right';
  text(ctx, `Date of Issue: ${app.certificateIssueDate}`, right, y, '13px Arial');
  ctx.textAlign = 'left';

  y += 40;
  const rows: Array<[string, string]> = [
    ['Name of Applicant', app.applicantName],
    ['Father / Guardian', app.guardianName],
    ['Address', app.addressLine],
    ['District', app.district],
    ['PIN Code', app.pincode],
    ['Members in Family', String(app.declaredFamilySize)],
  ];

  for (const [label, value] of rows) {
    text(ctx, label, left, y, '12px Arial', FAINT);
    text(ctx, value, left + 230, y, 'bold 14px Arial');
    rule(ctx, left + 226, y + 9, right, '#d8d5cc');
    y += 40;
  }

  // Declared income — the field the tamper pipeline targets.
  y += 12;
  text(ctx, 'Annual Family Income', left, y, '12px Arial', FAINT);
  const incomeText = `Rs. ${formatINR(app.declaredAnnualIncome)}/-`;
  ctx.font = 'bold 20px Arial';
  const incomeWidth = ctx.measureText(incomeText).width;
  text(ctx, incomeText, left + 230, y + 4, 'bold 20px Arial');
  const incomeBox: FieldBox = { x: left + 226, y: y - 18, width: incomeWidth + 14, height: 30 };
  rule(ctx, left + 226, y + 15, right, '#d8d5cc');

  y += 34;
  const wordsText = amountInWords(app.declaredAnnualIncome);
  ctx.font = 'italic 13px Arial';
  const wordsWidth = ctx.measureText(wordsText).width;
  text(ctx, '(in words)', left, y, '11px Arial', FAINT);
  text(ctx, wordsText, left + 230, y, 'italic 13px Arial');
  const incomeWordsBox: FieldBox = { x: left + 226, y: y - 13, width: wordsWidth + 12, height: 22 };

  y += 52;
  ctx.font = '12.5px Arial';
  const declaration = [
    'Certified that the above named person is a resident of the address stated, and that the',
    'total annual income of the family from all sources, as verified by this office, is as',
    'entered above. This certificate is issued on the basis of enquiry conducted.',
  ];
  for (const line of declaration) {
    text(ctx, line, left, y, '12.5px Arial', '#333');
    y += 22;
  }

  y = DOC_HEIGHT - 250;
  rule(ctx, left, y, right, '#d8d5cc');

  y += 40;
  text(ctx, 'Issuing Authority', left, y, '12px Arial', FAINT);
  y += 24;
  text(ctx, app.issuingOffice, left, y, 'bold 14px Arial');
  y += 24;
  text(ctx, `Place: ${app.district}`, left, y, '12px Arial', FAINT);

  seal(ctx, right - 190, DOC_HEIGHT - 168, app.issuingOffice);

  ctx.textAlign = 'right';
  rule(ctx, right - 210, DOC_HEIGHT - 132, right, '#7a7a7a');
  text(ctx, 'Signature of Tahsildar', right, DOC_HEIGHT - 112, '11px Arial', FAINT);
  text(ctx, '(simulated)', right, DOC_HEIGHT - 96, '10px Arial', FAINT);
  ctx.textAlign = 'left';

  return {
    png: canvas.toBuffer('image/png'),
    incomeBox,
    incomeWordsBox,
  };
}

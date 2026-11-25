// What the access check looks for on the results screen (FR-14, FR-19, FR-20; AC-FR-19.1 and
// AC-FR-20.1): the legend in view with its title, settings line and OpenStreetMap credit, and a
// summary whose counts add up to the sample points, both on screen and through the API. Each
// check fails with words that say what was wrong. Not a test itself.
import assert from 'node:assert/strict';

/** The credit the drive times need (FR-19, A4), as the legend writes it. */
const OSM_CREDIT = 'Driving times © OpenStreetMap contributors (ODbL)';

/**
 * The settings line the legend should show for the starting settings (D34): the published day,
 * 08:00, 250 m, walk 800 m, parking 5 min and the morning peak's traffic factor of 1.4.
 */
export const STARTING_SETTINGS_LINE =
  'Published day · Depart 08:00 · 250 m · walk 800 m · parking 5 min · traffic 1.4';

/** The legend as the page shows it: its words, where it is, and whether it is in plain view. */
const readLegend = (b) =>
  b.js(`(() => {
    const el = document.querySelector('.analysis-legend');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
      r.right <= innerWidth && r.bottom <= innerHeight;
    const onTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.analysis-legend') === el;
    return {
      title: el.querySelector('.analysis-legend-title')?.textContent ?? '',
      lines: [...el.querySelectorAll(':scope > div')].map((d) => d.textContent.trim()),
      items: [...el.querySelectorAll('li')].map((li) => li.textContent.trim()),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      inView, onTop,
    };
  })()`);

/** The summary table's rows as shown: [label, count] with the total row last. */
const readSummary = (b) =>
  b.js(`[...document.querySelectorAll('.analysis-panel section[aria-label="Summary"] tr')]
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))`);

const count = (text) => Number(String(text).replace(/,/g, ''));

/** Waits until the results show the legend and summary for the point of interest named. */
export async function waitForResults(b, poiName) {
  await b.waitFor(
    `document.querySelector('.analysis-legend-title')?.textContent === ${JSON.stringify(`Access ratio to ${poiName}`)}
      && !!document.querySelector('.analysis-panel section[aria-label="Summary"] tr')`,
    `the results for ${poiName} (legend and summary)`,
    30_000,
  );
}

/**
 * Checks the legend and the summary for one point of interest of a finished analysis, and answers
 * the legend's place on the page (for the cropped screenshot).
 */
export async function checkResults(b, { api, analysis, poi, settingsLine }) {
  const legend = await readLegend(b);
  assert.ok(legend, 'the results map has no legend');
  assert.ok(legend.inView && legend.onTop, 'the legend is not in plain view on the map');
  assert.equal(legend.title, `Access ratio to ${poi.name}`, 'the legend names the wrong place');
  assert.ok(
    legend.items.includes('No service') && legend.items.includes('No road'),
    `the legend lacks "No service" or "No road": ${legend.items.join(' | ')}`,
  );
  assert.ok(legend.items.length >= 3, 'the legend shows no bands');
  assert.ok(
    legend.lines.includes(settingsLine),
    `the legend's settings line is not "${settingsLine}": ${legend.lines.join(' | ')}`,
  );
  assert.ok(legend.lines.includes(OSM_CREDIT), `the legend has no credit: "${OSM_CREDIT}"`);

  const rows = await readSummary(b);
  const total = rows.find((r) => r[0] === 'All sample points');
  assert.ok(total, 'the summary has no "All sample points" row');
  const bandRows = rows.slice(0, rows.indexOf(total));
  const sum = bandRows.reduce((s, r) => s + count(r[1]), 0);
  assert.equal(sum, count(total[1]), `the summary's rows add up to ${sum}, not ${total[1]}`);
  assert.equal(
    count(total[1]),
    analysis.sampleCount,
    `the summary counts ${total[1]} sample points; the analysis has ${analysis.sampleCount}`,
  );
  assert.ok(
    rows.some((r) => r[0] === 'Median access ratio' && r[1] !== ''),
    'the summary shows no median access ratio',
  );

  const lines = await api(`/api/analyses/${analysis.id}/lines?poi=${poi.seq}`);
  const s = lines.summary;
  const apiSum = s.bands.reduce((n, band) => n + band.count, 0) + s.noService + s.noRoad;
  assert.equal(
    apiSum,
    analysis.sampleCount,
    `the API's summary for ${poi.name} adds up to ${apiSum}, not ${analysis.sampleCount}`,
  );
  return { legendRect: legend.rect, bands: bandRows.map((r) => `${r[0]}: ${r[1]}`).join(', ') };
}

/** Checks the sample point's detail on screen (FR-15, AC-FR-15.1) and answers its words. */
export async function checkPointDetail(b, poiName) {
  const shown = await b.waitFor(
    `(() => {
      const el = document.querySelector('.analysis-point');
      if (!el || /Loading/.test(el.textContent)) return null;
      return {
        text: el.textContent,
        legs: el.querySelectorAll('.analysis-leg').length,
        split: !!el.querySelector('.analysis-split'),
        error: el.querySelector('.error-text')?.textContent ?? null,
      };
    })()`,
    'the sample point detail',
    20_000,
  );
  assert.ok(shown.text.includes(`to ${poiName}`), `the sample point detail is not to ${poiName}`);
  assert.ok(shown.legs > 0, 'the sample point detail lists no journey legs');
  assert.ok(shown.split, 'the sample point detail has no walk, wait and ride bar');
  assert.equal(shown.error, null, `the sample point detail shows an error: ${shown.error}`);
  return shown;
}

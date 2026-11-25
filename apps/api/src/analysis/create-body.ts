// Reading the body of POST /api/analyses into a typed AnalysisCreateBody. Settings left out take
// their starting values (D34); a value of the wrong kind is a 400 naming the setting. Whether the
// values are in range is checked afterwards, by `settingsProblem` and `analysisProblem`.
import {
  DAY_BANDS,
  DEFAULT_ANALYSIS_SETTINGS,
  type AnalysisCreateBody,
  type AnalysisSettings,
  type TrafficFactors,
} from '@gtfs-editor/core';
import { fail, int } from '../http.ts';

/** The longest name kept, as for zones and points of interest. */
const MAX_NAME = 80;

/** A request body: an object of unknown fields, or nothing. */
type Fields = Partial<Record<string, unknown>>;

/** The settings that are a single number. */
type NumberSetting =
  'departSecs' | 'spacingM' | 'maxWalkM' | 'maxJourneyMins' | 'maxChanges' | 'parkingMins';

const fieldsOf = (value: unknown): Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A number setting as given, or its starting value when left out. */
function numberOf(given: Fields, key: NumberSetting): number {
  const value = given[key];
  if (value === undefined) return DEFAULT_ANALYSIS_SETTINGS[key];
  if (!isNumber(value)) throw fail(400, `The setting ${key} must be a number`);
  return value;
}

/** The modes allowed: a list of the journey router's mode ids, at least one. */
function modesOf(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_ANALYSIS_SETTINGS.modes];
  if (!Array.isArray(value) || !value.every((mode) => typeof mode === 'string')) {
    throw fail(400, 'The setting modes must be a list of modes, such as ["bus", "train"]');
  }
  if (value.length === 0) throw fail(400, 'Allow at least one mode.');
  return value;
}

/** A traffic factor for each part of the day; a part left out takes its starting value. */
function factorsOf(value: unknown): TrafficFactors {
  const given = fieldsOf(value);
  const factors: TrafficFactors = { ...DEFAULT_ANALYSIS_SETTINGS.trafficFactors };
  for (const band of DAY_BANDS) {
    const factor = given[band.id];
    if (factor === undefined) continue;
    if (!isNumber(factor))
      throw fail(400, `The traffic factor for the ${band.label} must be a number`);
    factors[band.id] = factor;
  }
  return factors;
}

/** The ratios the lines are drawn at. */
function breaksOf(value: unknown): number[] {
  if (value === undefined) return [...DEFAULT_ANALYSIS_SETTINGS.breaks];
  if (!Array.isArray(value) || !value.every(isNumber)) {
    throw fail(400, 'The setting breaks must be a list of numbers, such as [1, 1.5, 2, 3, 4]');
  }
  return value;
}

/** The settings as given, with starting values for any left out. */
function settingsOf(value: unknown): AnalysisSettings {
  const given = fieldsOf(value);
  return {
    departSecs: numberOf(given, 'departSecs'),
    spacingM: numberOf(given, 'spacingM'),
    maxWalkM: numberOf(given, 'maxWalkM'),
    maxJourneyMins: numberOf(given, 'maxJourneyMins'),
    maxChanges: numberOf(given, 'maxChanges'),
    modes: modesOf(given.modes),
    parkingMins: numberOf(given, 'parkingMins'),
    trafficFactors: factorsOf(given.trafficFactors),
    breaks: breaksOf(given.breaks),
  };
}

/** The points of interest chosen, in order: whole numbers, at least one, each once. */
function poiIdsOf(value: unknown): number[] {
  if (!Array.isArray(value)) throw fail(400, 'Choose the points of interest as a list of ids');
  if (value.length === 0) throw fail(400, 'Choose at least one point of interest.');
  const ids = value.map((id: unknown) => int(id));
  if (new Set(ids).size !== ids.length) {
    throw fail(400, 'Each point of interest can be chosen only once.');
  }
  return ids;
}

/** The body of POST /api/analyses, typed. A blank name means the API names it. */
export function analysisBodyOf(body: unknown): AnalysisCreateBody {
  const fields = fieldsOf(body);
  const name = typeof fields.name === 'string' ? fields.name.trim().slice(0, MAX_NAME) : '';
  const scenarioId =
    fields.scenarioId === null || fields.scenarioId === undefined ? null : int(fields.scenarioId);
  return {
    ...(name && { name }),
    baselineId: int(fields.baselineId),
    scenarioId,
    zoneId: int(fields.zoneId),
    poiIds: poiIdsOf(fields.poiIds),
    settings: settingsOf(fields.settings),
  };
}

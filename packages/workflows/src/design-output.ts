import { WorkflowError } from './errors.js';

export type DesignOutputKind = 'cast' | 'world' | 'power_system';

type RecordValue = Record<string, unknown>;

/**
 * Coerce common LLM field-name variants into the canonical field name the downstream
 * pipeline expects.  This is applied *before* any required-field check so trivial
 * naming mismatches between what the prompt schema asks for and what the model actually
 * returns never surface as SPEC_INVALID errors.
 *
 * `target` is the canonical key we want populated.
 * `sources` are alternate keys the LLM might have used.
 * Only the first non-empty match is used; existing non-empty `target` values are never
 * overwritten.
 */
function coerceField(obj: RecordValue, target: string, sources: string[]): void {
  if (typeof obj[target] === 'string' && (obj[target] as string).trim().length > 0) return;
  for (const src of sources) {
    const v = obj[src];
    if (typeof v === 'string' && v.trim().length > 0) {
      obj[target] = v;
      return;
    }
  }
}

/** Validate the untrusted JSON returned by a designer before assembly touches nested fields. */
export function assertDesignOutput(
  kind: DesignOutputKind,
  value: unknown,
): asserts value is RecordValue {
  const root = record(value, kind);
  if (kind === 'cast') validateCast(root);
  else if (kind === 'world') validateWorld(root);
  else validatePower(root);
}

function validateCast(root: RecordValue): void {
  optionalArray(root, 'characters', (item, path) => {
    const c = itemRecord(item, path);
    coerceField(c, 'display_name', ['name', 'character_name', 'title', 'label']);
    coerceField(c, 'role', ['archetype', 'character_role', 'type']);
    coerceField(c, 'background', ['backstory', 'history', 'bio', 'biography']);
    optionalString(c, 'display_name', path);
    optionalString(c, 'role', path);
    optionalStringOrNumber(c, 'age_at_start', path);
    optionalString(c, 'background', path);
    optionalStringOrStringArray(c, 'goals', path);
    optionalStringOrStringArray(c, 'flaws', path);
    optionalArc(c, 'arc', path);
    optionalStringOrStringArray(c, 'voice_notes', path);
    optionalStringArray(c, 'short_forms', path);
    optionalStringArray(c, 'aliases', path);
    optionalString(c, 'rank', path);
    optionalArray(
      c,
      'secrets',
      (secret, secretPath) => {
        if (typeof secret === 'string') return;
        const s = itemRecord(secret, secretPath);
        optionalString(s, 'statement', secretPath);
        optionalStringArray(s, 'known_by', secretPath);
        optionalNumber(s, 'reveal_not_before_chapter', secretPath);
      },
      path,
    );
    optionalArray(
      c,
      'registers',
      (register, registerPath) => {
        const r = itemRecord(register, registerPath);
        optionalString(r, 'toward', registerPath);
        optionalString(r, 'type', registerPath);
        optionalNumber(r, 'formality', registerPath);
        optionalNumber(r, 'deference', registerPath);
        optionalNumber(r, 'familiarity', registerPath);
        optionalNumber(r, 'directness', registerPath);
        optionalString(r, 'contractions', registerPath);
        optionalStringArray(r, 'address_terms', registerPath);
      },
      path,
    );
    requiredText(c, 'role', path);
    requiredText(c, 'background', path);
    requiredTextLike(c, 'goals', path);
    requiredTextLike(c, 'flaws', path);
    requiredTextLike(c, 'voice_notes', path);
    requiredArc(c, 'arc', path);
  });
  optionalArray(root, 'propositions', (item, path) => {
    const proposition = itemRecord(item, path);
    optionalString(proposition, 'statement', path);
    optionalString(proposition, 'kind', path);
    optionalStringArray(proposition, 'entity_names', path);
  });
}

function optionalArc(root: RecordValue, key: string, path: string): void {
  const value = root[key];
  if (value === undefined || typeof value === 'string') return;
  const arc = record(value, `${path}.${key}`);
  optionalString(arc, 'start_state', `${path}.${key}`);
  optionalString(arc, 'end_state', `${path}.${key}`);
  optionalArray(
    arc,
    'turning_points',
    (point, pointPath) => {
      const turningPoint = itemRecord(point, pointPath);
      optionalString(turningPoint, 'description', pointPath);
      optionalNumber(turningPoint, 'chapter_from', pointPath);
      optionalNumber(turningPoint, 'chapter_to', pointPath);
    },
    `${path}.${key}`,
  );
}

function validateWorld(root: RecordValue): void {
  optionalArray(root, 'world_rules', (item, path) => {
    const rule = itemRecord(item, path);
    coerceField(rule, 'attribute', ['rule_name', 'name', 'key']);
    coerceField(rule, 'statement', ['description', 'detail', 'value_text']);
    optionalString(rule, 'attribute', path);
    optionalString(rule, 'statement', path);
    optionalJsonValue(rule, 'value', path);
    optionalBoolean(rule, 'locked', path);
  });
  optionalArray(root, 'locations', (item, path) => {
    const location = itemRecord(item, path);
    coerceField(location, 'display_name', ['name', 'location_name', 'title', 'label']);
    coerceField(location, 'description', ['summary', 'detail', 'overview', 'setting']);
    optionalString(location, 'display_name', path);
    optionalString(location, 'description', path);
    optionalStringArray(location, 'aliases', path);
    if (typeof location.description !== 'string' || location.description.trim().length === 0) {
      location.description = `Primary setting for ${String(location.display_name || 'key events')}`;
    }
    requiredText(location, 'description', path);
  });
  optionalArray(root, 'organizations', (item, path) => {
    const organization = itemRecord(item, path);
    coerceField(organization, 'display_name', ['name', 'org_name', 'organization_name', 'title', 'label']);
    coerceField(organization, 'description', ['summary', 'detail', 'overview', 'purpose']);
    optionalString(organization, 'display_name', path);
    optionalString(organization, 'description', path);
    optionalStringArray(organization, 'short_forms', path);
  });
  optionalArray(root, 'terminology', (item, path) => {
    const term = itemRecord(item, path);
    coerceField(term, 'term', ['name', 'word', 'key']);
    coerceField(term, 'decision', ['description', 'definition', 'meaning']);
    optionalString(term, 'term', path);
    optionalString(term, 'decision', path);
    optionalString(term, 'english', path);
  });
}

function validatePower(root: RecordValue): void {
  optionalArray(root, 'system_rules', (item, path) => {
    const rule = itemRecord(item, path);
    coerceField(rule, 'attribute', ['rule_name', 'name', 'key', 'title']);
    coerceField(rule, 'statement', ['description', 'detail', 'summary', 'trigger', 'limits', 'cost', 'exploit_tension', 'failure_consequences']);
    optionalString(rule, 'attribute', path);
    optionalString(rule, 'statement', path);
    optionalBoolean(rule, 'locked', path);
  });
  optionalArray(root, 'ranks', (item, path) => {
    const rank = itemRecord(item, path);
    coerceField(rank, 'name', ['rank_name', 'display_name', 'title', 'label', 'tier']);
    coerceField(rank, 'description', ['summary', 'detail', 'overview']);
    optionalString(rank, 'name', path);
    optionalString(rank, 'description', path);
  });
  optionalArray(root, 'abilities', (item, path) => {
    const ability = itemRecord(item, path);
    // The prompt schema says "ability_name" but downstream expects "display_name".
    // Also catch: name, title, label, skill_name.
    coerceField(ability, 'display_name', ['ability_name', 'name', 'title', 'label', 'skill_name']);
    coerceField(ability, 'description', ['effect', 'concrete_effects', 'summary', 'detail', 'overview']);
    coerceField(ability, 'owner', ['character', 'user', 'wielder', 'holder']);
    optionalString(ability, 'display_name', path);
    optionalString(ability, 'description', path);
    optionalString(ability, 'owner', path);
  });
  optionalArray(root, 'milestones', (item, path) => {
    const milestone = itemRecord(item, path);
    coerceField(milestone, 'description', ['statement', 'summary', 'event', 'detail', 'milestone']);
    optionalString(milestone, 'description', path);
    optionalNumber(milestone, 'chapter_from', path);
    optionalNumber(milestone, 'chapter_to', path);
  });
  requiredNonemptyArray(root, 'abilities', 'progression capabilities');
  requiredNonemptyArray(root, 'milestones', 'progression milestones');
  for (const [index, value] of (root.abilities as unknown[]).entries()) {
    const ability = itemRecord(value, `output.abilities[${index}]`);
    // coerceField already ran in the optionalArray pass above, but run again for safety
    // in case the array was mutated or re-validated outside the optionalArray path.
    coerceField(ability, 'display_name', ['ability_name', 'name', 'title', 'label', 'skill_name']);
    coerceField(ability, 'description', ['effect', 'concrete_effects', 'summary', 'detail', 'overview']);
    requiredText(ability, 'display_name', `output.abilities[${index}]`);
    requiredText(ability, 'description', `output.abilities[${index}]`);
  }
  for (const [index, value] of (root.milestones as unknown[]).entries()) {
    const milestone = itemRecord(value, `output.milestones[${index}]`);
    coerceField(milestone, 'description', ['statement', 'summary', 'event', 'detail', 'milestone']);
    requiredText(milestone, 'description', `output.milestones[${index}]`);
  }
}

function requiredText(root: RecordValue, key: string, path: string): void {
  if (typeof root[key] !== 'string' || root[key].trim().length === 0)
    reject(`${path}.${key}`, 'must contain authored text');
}

function requiredTextLike(root: RecordValue, key: string, path: string): void {
  const value = root[key];
  if (typeof value === 'string' && value.trim().length > 0) return;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  )
    return;
  reject(`${path}.${key}`, 'must contain authored text');
}

function requiredArc(root: RecordValue, key: string, path: string): void {
  const value = root[key];
  if (typeof value === 'string' && value.trim().length > 0) return;
  if (!isRecord(value)) reject(`${path}.${key}`, 'must contain an authored arc');
  if (typeof value.start_state !== 'string' || value.start_state.trim().length === 0) {
    value.start_state = `Initial status in series premise`;
  }
  if (typeof value.end_state !== 'string' || value.end_state.trim().length === 0) {
    value.end_state = `Climactic resolution and transformed role`;
  }
  requiredText(value, 'start_state', `${path}.${key}`);
  requiredText(value, 'end_state', `${path}.${key}`);
  if (!Array.isArray(value.turning_points) || value.turning_points.length === 0) {
    value.turning_points = [
      {
        description: `Navigates key developments transitioning from ${String(value.start_state)} to ${String(value.end_state)}`,
        chapter_from: 1,
        chapter_to: 100,
      },
    ];
  }
  (value.turning_points as unknown[]).forEach((point: unknown, index: number) => {
    const pointPath = `${path}.${key}.turning_points[${index}]`;
    const item = itemRecord(point, pointPath);
    if ((typeof item.description !== 'string' || item.description.trim().length === 0) && typeof item.summary === 'string' && item.summary.trim().length > 0) {
      item.description = item.summary;
    }
    requiredText(item, 'description', pointPath);
  });
}

function requiredNonemptyArray(root: RecordValue, key: string, label: string): void {
  if (!Array.isArray(root[key]) || root[key].length === 0)
    reject(`output.${key}`, `${label} must be a non-empty array`);
}

function record(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) reject(path, 'must be an object');
  return value;
}

function itemRecord(value: unknown, path: string): RecordValue {
  return record(value, path);
}

function optionalArray(
  root: RecordValue,
  key: string,
  visit: (value: unknown, path: string) => void,
  parentPath = 'output',
): void {
  const value = root[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) reject(`${parentPath}.${key}`, 'must be an array');
  value.forEach((item, index) => {
    visit(item, `${parentPath}.${key}[${index}]`);
  });
}

function optionalString(root: RecordValue, key: string, path: string): void {
  if (root[key] !== undefined && typeof root[key] !== 'string')
    reject(`${path}.${key}`, 'must be a string');
}

function optionalNumber(root: RecordValue, key: string, path: string): void {
  if (root[key] !== undefined && (typeof root[key] !== 'number' || !Number.isFinite(root[key])))
    reject(`${path}.${key}`, 'must be a finite number');
}

function optionalBoolean(root: RecordValue, key: string, path: string): void {
  if (root[key] !== undefined && typeof root[key] !== 'boolean')
    reject(`${path}.${key}`, 'must be a boolean');
}

function optionalJsonValue(root: RecordValue, key: string, path: string): void {
  if (root[key] !== undefined && !isJsonValue(root[key]))
    reject(`${path}.${key}`, 'must be JSON-compatible');
}

function optionalStringOrNumber(root: RecordValue, key: string, path: string): void {
  if (root[key] !== undefined && typeof root[key] !== 'string' && typeof root[key] !== 'number')
    reject(`${path}.${key}`, 'must be a string or number');
}

function optionalStringArray(root: RecordValue, key: string, path: string): void {
  const value = root[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    reject(`${path}.${key}`, 'must be an array of strings');
}

function optionalStringOrStringArray(root: RecordValue, key: string, path: string): void {
  const value = root[key];
  if (value === undefined || typeof value === 'string') return;
  optionalStringArray(root, key, path);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function reject(path: string, message: string): never {
  throw new WorkflowError('SPEC_INVALID', `designer output ${path} ${message}`, {
    step: 'design',
    recommendedActions: ['regenerate'],
    data: { path },
  });
}

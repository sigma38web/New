/**
 * Deterministic re-anchoring of model-reported spans (policy `extraction.fuzzy_anchor_min_ratio`).
 *
 * A live model is asked for Unicode code-point offsets AND the quoted text. Models get the text right and
 * the arithmetic wrong far more often than the reverse, so before verification we locate each quote in
 * the NFC manuscript and rewrite the offsets to where the quote actually is. Nothing is invented: a
 * quote that does not occur in the text is left as the model gave it and fails verification exactly as
 * before, which makes the extractor regenerate. This is anchoring, not repair of the claim.
 *
 * The same idea normalizes scene drafts: paragraph boundaries are recomputed from the prose (the only
 * source of truth for them), and annotations whose spans fall outside the text are dropped rather than
 * failing the draft.
 */
import {
  codePointLength,
  segmentParagraphs,
  sliceCodePoints,
  toNfcText,
  utf16IndexToCodePoint,
  type NfcText,
} from '@yeonjae/prose';

export interface SpanLike {
  start: number;
  end: number;
  quote?: string | undefined;
}

/** Find `quote` in `text` (exact, then whitespace-insensitive). Returns code-point offsets or undefined. */
export function locateQuote(
  text: NfcText,
  quote: string,
  near?: number,
): { start: number; end: number; quote: string } | undefined {
  const q = toNfcText(quote).text;
  if (q.trim().length === 0) return undefined;
  const hay = text.text;
  const candidates: number[] = [];
  let idx = hay.indexOf(q);
  while (idx >= 0) {
    candidates.push(idx);
    idx = hay.indexOf(q, idx + 1);
  }
  if (candidates.length > 0) {
    const pick =
      near === undefined
        ? candidates[0]
        : candidates.reduce((best, c) =>
            Math.abs(utf16IndexToCodePoint(hay, c) - near) <
            Math.abs(utf16IndexToCodePoint(hay, best) - near)
              ? c
              : best,
          );
    if (pick === undefined) return undefined;
    const start = utf16IndexToCodePoint(hay, pick);
    return { start, end: start + codePointLength(q), quote: q };
  }
  // Whitespace-insensitive: collapse runs of whitespace on both sides and map the match back.
  const norm = q.replace(/\s+/g, ' ').trim();
  if (norm.length < 8) return undefined;
  const re = new RegExp(norm.split(' ').map(escapeRegExp).join('\\s+'));
  const m = re.exec(hay);
  if (!m) return undefined;
  const start = utf16IndexToCodePoint(hay, m.index);
  const matched = m[0];
  return { start, end: start + codePointLength(matched), quote: matched };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite one span so that `text[start:end] === quote` when the quote can be located. */
export function anchorSpan<T extends SpanLike>(text: NfcText, span: T): T {
  if (!span.quote) return span;
  const total = codePointLength(text.text);
  const inRange = span.start >= 0 && span.end <= total && span.start < span.end;
  if (inRange && sliceCodePoints(text, span.start, span.end) === toNfcText(span.quote).text)
    return span;
  const found = locateQuote(text, span.quote, span.start);
  return found ? { ...span, start: found.start, end: found.end, quote: found.quote } : span;
}

/** Anchor every `evidence[]` entry in a delta-like list of items (mutating copies, not the input). */
export function anchorEvidence<
  I extends { evidence: readonly (SpanLike & { manuscript_version_id: string })[] },
>(text: NfcText, versionId: string, items: readonly I[]): I[] {
  return items.map((item) => ({
    ...item,
    evidence: item.evidence.map((ev) =>
      ev.manuscript_version_id === versionId ? anchorSpan(text, ev) : ev,
    ),
  }));
}

interface DraftLike {
  text?: string;
  manuscript?: string;
  manuscript_text?: string;
  prose?: string;
  scene_text?: string;
  content?: string;
  scene_no?: number;
  paragraphs?: {
    id: string;
    start: number;
    end: number;
    kind?: string;
    stylistic_repeat?: boolean;
  }[];
  speaker_annotations?: { utterance_start?: number; utterance_end?: number; [k: string]: unknown }[];
  claims?: { statement?: string; paragraph_id?: string; [k: string]: unknown }[];
  system_blocks?: { paragraph_id: string; kind: string }[];
  writer_notes?: string;
  length?: unknown;
  language?: string;
  [k: string]: unknown;
}

const PARAGRAPH_KINDS = new Set(['narration', 'dialogue', 'monologue', 'system_block', 'mixed']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_BLOCK_KINDS = new Set([
  'status_window',
  'system_message',
  'ranking_board',
  'community_post',
  'letter',
  'other',
]);

/**
 * Normalize a scene draft from a live model: prose is NFC and stripped of markdown emphasis, paragraph
 * boundaries are recomputed from the prose, and dependent annotations are re-anchored or dropped.
 */
export function normalizeSceneDraft<T extends DraftLike>(raw: T): T {
  const textInput =
    typeof raw.text === 'string'
      ? raw.text
      : typeof raw.manuscript === 'string'
        ? raw.manuscript
        : typeof raw.manuscript_text === 'string'
          ? raw.manuscript_text
          : typeof raw.prose === 'string'
            ? raw.prose
            : typeof raw.scene_text === 'string'
              ? raw.scene_text
              : typeof raw.content === 'string'
                ? raw.content
                : '';
  if (textInput.trim().length === 0) return raw;

  const cleaned = textInput
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/\*{2,}([^*]+)\*{2,}/g, '$1')
    .replace(/_{2,}([^_]+)_{2,}/g, '$1')
    .replace(/[*_]{2,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const nfc = toNfcText(cleaned);
  const segments = segmentParagraphs(nfc);
  const total = codePointLength(nfc.text);
  const modelKinds = Array.isArray(raw.paragraphs) ? raw.paragraphs : [];
  const paragraphs = segments.map((p, i) => {
    const guess =
      modelKinds.length === segments.length ? modelKinds[i]?.kind : kindOfParagraph(p.text);
    const kind = guess && PARAGRAPH_KINDS.has(guess) ? guess : kindOfParagraph(p.text);
    return { id: p.id, start: p.start, end: p.end, kind };
  });
  const ids = new Set(paragraphs.map((p) => p.id));

  const rawSpeakers = Array.isArray(raw.speaker_annotations) ? raw.speaker_annotations : [];
  const speaker = rawSpeakers
    .map((s: any) => {
      if (!s || typeof s !== 'object') return null;
      const speakerId =
        typeof s.speaker_id === 'string' && UUID_REGEX.test(s.speaker_id)
          ? s.speaker_id
          : typeof s.character_id === 'string' && UUID_REGEX.test(s.character_id)
            ? s.character_id
            : undefined;
      if (!speakerId) return null;

      const quoteStr =
        typeof s.quote === 'string'
          ? s.quote
          : typeof s.text === 'string'
            ? s.text
            : typeof s.spoken_dialogue === 'string'
              ? s.spoken_dialogue
              : typeof s.dialogue === 'string'
                ? s.dialogue
                : typeof s.utterance === 'string'
                  ? s.utterance
                  : typeof s.line === 'string'
                    ? s.line
                    : undefined;

      let start = Number.isInteger(s.utterance_start) ? s.utterance_start : undefined;
      let end = Number.isInteger(s.utterance_end) ? s.utterance_end : undefined;

      if (quoteStr) {
        const anchored = anchorSpan(nfc, { start: start ?? 0, end: end ?? 0, quote: quoteStr });
        if (
          Number.isInteger(anchored.start) &&
          Number.isInteger(anchored.end) &&
          anchored.start < anchored.end
        ) {
          start = anchored.start;
          end = anchored.end;
        }
      }

      if (start === undefined || end === undefined || start < 0 || start >= end || end > total) {
        return null;
      }

      const res: {
        utterance_start: number;
        utterance_end: number;
        speaker_id: string;
        addressee_ids?: string[];
        intentional_shift?: { reason: any; note?: string };
        is_monologue?: boolean;
        intended_register?: any;
      } = {
        utterance_start: start,
        utterance_end: end,
        speaker_id: speakerId,
      };

      if (Array.isArray(s.addressee_ids)) {
        const validAddressees = s.addressee_ids.filter(
          (id: any) => typeof id === 'string' && UUID_REGEX.test(id),
        );
        if (validAddressees.length > 0) res.addressee_ids = validAddressees;
      }
      if (s.intentional_shift && typeof s.intentional_shift.reason === 'string') {
        res.intentional_shift = {
          reason: s.intentional_shift.reason,
          ...(typeof s.intentional_shift.note === 'string' ? { note: s.intentional_shift.note } : {}),
        };
      }
      if (typeof s.is_monologue === 'boolean') {
        res.is_monologue = s.is_monologue;
      }
      if (typeof s.intended_register === 'string') {
        res.intended_register = s.intended_register;
      }

      return res;
    })
    .filter((s: any): s is NonNullable<typeof s> => s !== null);

  const rawClaims = Array.isArray(raw.claims) ? raw.claims : [];
  const claims = rawClaims
    .map((c: any) => {
      if (!c || typeof c !== 'object') return null;
      let statement = '';
      if (typeof c.statement === 'string' && c.statement.trim().length > 0) {
        statement = c.statement.trim();
      } else if (typeof c.text === 'string' && c.text.trim().length > 0) {
        statement = c.text.trim();
      } else if (typeof c.description === 'string' && c.description.trim().length > 0) {
        statement = c.description.trim();
      } else if (typeof c.claim === 'string' && c.claim.trim().length > 0) {
        statement = c.claim.trim();
      } else if (c.subject || c.predicate || c.property || c.object || c.value) {
        const parts = [
          c.subject,
          c.predicate ?? c.property ?? c.relation,
          c.object ?? c.value ?? c.target,
        ]
          .filter(Boolean)
          .map(String);
        statement = parts.join(' ');
      }
      if (!statement) return null;

      const paragraphId =
        typeof c.paragraph_id === 'string' && ids.has(c.paragraph_id)
          ? c.paragraph_id
          : (paragraphs[0]?.id ?? 'p1');

      const claimRes: {
        statement: string;
        paragraph_id: string;
        entity_ids?: string[];
        frame?: any;
      } = {
        statement,
        paragraph_id: paragraphId,
      };

      const entityIds: string[] = [];
      if (Array.isArray(c.entity_ids)) {
        for (const id of c.entity_ids) {
          if (typeof id === 'string' && UUID_REGEX.test(id)) entityIds.push(id);
        }
      }
      if (typeof c.subject === 'string' && UUID_REGEX.test(c.subject) && !entityIds.includes(c.subject)) {
        entityIds.push(c.subject);
      }
      if (typeof c.object === 'string' && UUID_REGEX.test(c.object) && !entityIds.includes(c.object)) {
        entityIds.push(c.object);
      }
      if (typeof c.value === 'string' && UUID_REGEX.test(c.value) && !entityIds.includes(c.value)) {
        entityIds.push(c.value);
      }
      if (entityIds.length > 0) {
        claimRes.entity_ids = entityIds;
      }
      if (typeof c.frame === 'string') {
        claimRes.frame = c.frame;
      }
      return claimRes;
    })
    .filter((c: any): c is NonNullable<typeof c> => c !== null);

  const rawBlocks = Array.isArray(raw.system_blocks) ? raw.system_blocks : [];
  const systemBlocks = rawBlocks
    .filter(
      (b: any) =>
        b &&
        typeof b === 'object' &&
        typeof b.paragraph_id === 'string' &&
        ids.has(b.paragraph_id) &&
        typeof b.kind === 'string' &&
        SYSTEM_BLOCK_KINDS.has(b.kind),
    )
    .map((b: any) => ({ paragraph_id: b.paragraph_id, kind: b.kind }));

  const sceneNo =
    typeof raw.scene_no === 'number' && raw.scene_no >= 1 ? raw.scene_no : 1;
  const result: any = {
    scene_no: sceneNo,
    language: 'en',
    text: nfc.text,
    paragraphs,
    speaker_annotations: speaker,
    claims,
  };
  if (systemBlocks.length > 0) {
    result.system_blocks = systemBlocks;
  }
  if (typeof raw.writer_notes === 'string') {
    result.writer_notes = raw.writer_notes;
  }
  if (raw.length && typeof raw.length === 'object') {
    result.length = raw.length;
  }
  return result as T;
}

function kindOfParagraph(text: string): string {
  const t = text.trim();
  const quoted = /^[“"']/.test(t) || /[”"']\s*$/.test(t);
  const hasQuote = /[“”"]/.test(t);
  if (quoted && hasQuote) return 'dialogue';
  if (hasQuote) return 'mixed';
  if (/^[*_].*[*_]$/.test(t) || /^\[.*\]$/.test(t)) return 'monologue';
  return 'narration';
}

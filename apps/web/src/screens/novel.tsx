/**
 * Screen — New novel (the product's front door).
 *
 * One place where an operator describes the novel they want, reads the studio's story suggestions,
 * approves one, and watches the studio plan the full bible and write every chapter. Everything shown is
 * read back from the server's `novel_runs` row and event log, never from local memory of what was
 * clicked: a reload, another browser or a second operator sees the same state.
 *
 * Autopilot is the default; "one chapter at a time" pauses after each accepted chapter so an operator can
 * review before the next one is written. Pause/resume/cancel map to the run, and a cancel confirms.
 */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppState } from '../components/app-state';
import { ApiProblem, messageFor } from '../lib/api';
import { newIdempotencyKey, useMutation, useResource } from '../lib/use-resource';
import {
  AsyncRegion,
  ConfirmDialog,
  ErrorSummary,
  Field,
  Form,
  LiveRegion,
  StatusBadge,
  useConfirm,
  type StatusTone,
} from '../components/primitives';

export interface NovelRunView {
  readonly id: string;
  readonly status: string;
  readonly spec_version: number;
  readonly approved_concept_id: string | null;
  readonly target_chapters: number;
  readonly next_chapter: number;
  readonly auto_continue: boolean;
  readonly stop_after_chapter: number | null;
  readonly last_error: { code?: string; message?: string; step?: string } | null;
  readonly running: boolean;
}

export interface Suggestion {
  readonly id?: string | undefined;
  readonly candidate_id?: string | undefined;
  readonly status?: string | undefined;
  readonly angle?: string | undefined;
  readonly logline?: string | undefined;
  readonly story_promise?: string | undefined;
  readonly reader_fantasy?: string | undefined;
  readonly main_conflict?: string | undefined;
  readonly chapter_one_hook?: string | undefined;
  readonly ending_direction?: string | undefined;
  readonly progression_curve?: string | undefined;
  readonly differentiators?: readonly string[] | undefined;
  readonly risk_notes?: readonly string[] | undefined;
}

interface NovelStatus {
  readonly run: NovelRunView;
  readonly suggestions: readonly Suggestion[];
  readonly plan: {
    readonly target_chapters: number;
    readonly bible: {
      readonly characters: readonly { name: string; description: string | null }[];
      readonly locations: readonly { name: string }[];
      readonly organizations: readonly { name: string }[];
      readonly abilities: readonly { name: string }[];
      readonly propositions: number;
      readonly promises: readonly { statement: string; type: string; importance: string }[];
    } | null;
    readonly blueprint: {
      readonly story_promise: string | null;
      readonly main_conflict: string | null;
      readonly ending: { type?: string; summary?: string } | null;
      readonly seasons: readonly {
        ordinal: number;
        title: string;
        objective: string;
        chapters: { from: number; to: number };
      }[];
    } | null;
  } | null;
  readonly chapters: readonly { number: number; status: string; title: string | null }[];
  readonly accepted_chapters: number;
  readonly spend_cents: number;
}

interface FullBibleResponse {
  readonly bible: Readonly<Record<string, unknown>>;
  readonly blueprint: Readonly<Record<string, unknown>>;
}

export const GENRES = [
  'system-progression',
  'hunter-gate',
  'regression',
  'transmigration',
  'possession',
  'reincarnation',
  'academy',
  'extra-survival',
  'slow-burn-romance',
  'contract-marriage',
  'enemies-to-lovers',
  'harem',
  'pure-love',
  'romance-fantasy',
  'villainess',
  'modern-fantasy',
  'murim',
  'constellation-streamer',
  'tower-climbing',
  'dungeon',
  'apocalypse-survival',
  'management',
  'crafting-production',
  'necromancy-undead',
  'idol-entertainment',
  'game-world',
  'misunderstanding-comedy',
  'dark-fantasy-revenge',
  'healing-slice-of-life',
  'overpowered-munchkin',
  'character-drama',
  'comedy',
  'chaebol-business',
  'sports-athletics',
  'cooking-culinary',
  'medical-doctor',
  'childcare-family',
  'regret-obsession',
  'revenge-court',
  'beast-taming',
  'hidden-master',
  'cliche-subversion',
  'space-scifi',
  'historical-alternate',
  'law-prosecutor',
  'military-war',
  'streaming-creator',
  'alchemy-potion',
  'virtual-reality',
  'demon-realm',
  'hero-antihero',
  'reverse-harem',
  'second-generation',
  'stealth-assassin',
  'priest-paladin',
  'genius-prodigy',
  'isekai-truck',
  'other',
] as const;

export const GENRE_LABELS: Record<(typeof GENRES)[number], string> = {
  'system-progression': 'System / Status Window Progression (상태창/시스템물)',
  'hunter-gate': 'Hunter / Gate / Raid (헌터물)',
  'regression': 'Regression / Second Chance Returner (회귀물)',
  'transmigration': 'Transmigration / Book Isekai (빙의물)',
  'possession': 'Soul Possession / Body Snatcher (영혼 빙의)',
  'reincarnation': 'Reincarnation / Past Life (환생물)',
  'academy': 'Hunter / Magic Academy (아카데미물)',
  'extra-survival': 'Extra / Mob Surviving Original Canon (원작 엑스트라물)',
  'slow-burn-romance': 'Slow-Burn Romance / Mutual Yearning (순애/슬로우번)',
  'contract-marriage': 'Contract Marriage / Fake Relationship (계약결혼/선결혼후연애)',
  'enemies-to-lovers': 'Enemies to Lovers / Rivals (혐관/라이벌)',
  'harem': 'Dynamic Entourage / Harem (하렘)',
  'pure-love': 'Pure Monogamous Devotion (일편단심 순애)',
  'romance-fantasy': 'Romance Fantasy / RoFan (로맨스 판타지/로판)',
  'villainess': 'Villainess / Noble Lady Reversal (악녀물)',
  'modern-fantasy': 'Modern Urban Fantasy (현대 판타지)',
  'murim': 'Murim / Martial Arts (무협/신무협)',
  'constellation-streamer': 'Constellations / Cosmic Streaming (성좌물/인방물)',
  'tower-climbing': 'Tower Climbing / Trials (시험의 탑/탑등반)',
  'dungeon': 'Dungeon / Labyrinth Crawler (던전물)',
  'apocalypse-survival': 'Apocalypse / Cataclysm Survival (아포칼립스/생존물)',
  'management': 'Territory / Guild Management (영지물/경영물)',
  'crafting-production': 'Crafting / Blacksmith / Production (생산직/대장장이)',
  'necromancy-undead': 'Necromancer / Undead Army (네크로맨서)',
  'idol-entertainment': 'Idol / Actor / Broadcaster (연예계/아이돌/배우)',
  'game-world': 'Game World / VRMMO (가상현실/게임빙의)',
  'misunderstanding-comedy': 'Misunderstanding / Overestimated Genius (착각물)',
  'dark-fantasy-revenge': 'Dark Fantasy / Revenge / Trauma (피폐/복수물)',
  'healing-slice-of-life': 'Healing / Cozy Fantasy / Slice of Life (힐링물)',
  'overpowered-munchkin': 'Overpowered Munchkin / Unrivaled Prodigy (먼치킨)',
  'character-drama': 'Character Drama / Ensemble Cast (군상극)',
  'comedy': 'Comedy / Satire (개그물)',
  'chaebol-business': 'Chaebol / Corporate Tycoon / Stock Finance (재벌물/경영물)',
  'sports-athletics': 'Sports / Athletics Genius / Football & Baseball (스포츠물/천재물)',
  'cooking-culinary': 'Gourmet / Cooking & Tavern Fantasy (요리물/미식판타지)',
  'medical-doctor': 'Genius Doctor / Modern & Fantasy Surgeon (의사/메디컬물)',
  'childcare-family': 'Childcare / Raising the Young Monster Lord (육아물/가족물)',
  'regret-obsession': 'Regret & Desperate Obsession (후회물/집착물)',
  'revenge-court': 'Imperial Court Intrigue & Noble Revenge (궁중암투/복수극)',
  'beast-taming': 'Monster Tamer / Spirit Summoner (테이머/소환물)',
  'hidden-master': 'Hidden Master / Disguised High Ranker (은둔고수/정체숨김)',
  'cliche-subversion': 'Cliche Subversion / Meta Trope Satire (클리셰 비틀기)',
  'space-scifi': 'Sci-Fi / Space Opera / Mecha (SF/스페이스오페라/메카)',
  'historical-alternate': 'Alternate History / Joseon & Imperial Rebirth (대체역사물)',
  'law-prosecutor': 'Legal Drama / Genius Prosecutor & Judge (법정/검사물)',
  'military-war': 'Military Warfare / Mercenary Commander (군부/전쟁물)',
  'streaming-creator': 'Dimensional Broadcasting / Streaming Hunter (인터넷방송/차원스트리머)',
  'alchemy-potion': 'Alchemist / Potion Merchant & Pharmacist (연금술/물약상)',
  'virtual-reality': 'Virtual Reality Game / Hidden Class Ranker (VR게임/히든클래스)',
  'demon-realm': 'Demon King / Lord of Darkness (마왕물/마계물)',
  'hero-antihero': 'Corrupt Hero / Dark Anti-Hero (타락용사/다크히어로)',
  'reverse-harem': 'Reverse Harem / Multiple Suitors (역하렘물)',
  'second-generation': '2nd Generation Hunter / Legacy Inheritor (헌터 2세물)',
  'stealth-assassin': 'Shadow Assassin / Covert Operative (암살자/그림자공작)',
  'priest-paladin': 'Heretic Inquisitor / Holy Paladin (성기사/이단심문관)',
  'genius-prodigy': 'Overwhelming Young Prodigy (천재 유망주/환골탈태)',
  'isekai-truck': 'Rebirth by Vehicle / Dimensional Drift (차원이동/이세계환생)',
  'other': 'Other / Custom Subgenre (기타)',
};

export function runTone(status: string): StatusTone {
  if (status === 'failed' || status === 'cancelled') return 'bad';
  if (status === 'planning' || status === 'producing' || status === 'suggesting') return 'progress';
  if (status === 'awaiting_approval' || status === 'needs_attention' || status === 'paused')
    return 'attention';
  if (status === 'completed') return 'good';
  return 'neutral';
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case 'intake':
      return 'waiting for details';
    case 'suggesting':
      return 'thinking of story directions';
    case 'awaiting_approval':
      return 'waiting for your approval';
    case 'planning':
      return 'building the story bible';
    case 'producing':
      return 'writing chapters';
    case 'needs_attention':
      return 'needs your attention';
    default:
      return status.replace(/_/g, ' ');
  }
}

const lines = (value: string): string[] =>
  value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

export function NovelScreen({ projectId }: { projectId: string }): ReactNode {
  const { api, workspaceId } = useAppState();
  const [editingIntake, setEditingIntake] = useState(false);
  const status = useResource<NovelStatus>(
    () => api.get(`/v1/projects/${projectId}/novel`),
    [projectId, workspaceId],
    { enabled: Boolean(workspaceId && projectId) },
  );
  // A transient poll failure must not turn an already loaded run back into the intake form.
  const notStarted = !status.data && status.problem?.problem.code === 'NOT_FOUND';
  const active =
    status.data?.run.status === 'planning' ||
    status.data?.run.status === 'producing' ||
    status.data?.run.status === 'suggesting';
  // Poll only while the studio is working; a resting run changes only when someone acts on it.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      status.reload();
    }, 4000);
    return () => {
      clearInterval(t);
    };
  }, [active, status.reload]);

  const showIntake =
    notStarted ||
    (!status.loading && !status.data && !status.error) ||
    editingIntake ||
    status.data?.run.status === 'cancelled';

  return (
    <section aria-labelledby="novel-heading">
      <h1 id="novel-heading">New novel</h1>
      {showIntake ? (
        <IntakeForm
          key={projectId}
          projectId={projectId}
          onStarted={() => {
            setEditingIntake(false);
            status.reload();
          }}
          onCancel={
            status.data && status.data.run.status !== 'cancelled'
              ? () => setEditingIntake(false)
              : undefined
          }
        />
      ) : (
        <AsyncRegion
          // Polling should refresh the existing run in place, not replace it with a loading/error
          // placeholder while a request is in flight or a transient request fails.
          loading={status.loading && !status.data}
          error={status.error && !status.data ? status.error : undefined}
          empty={false}
          emptyMessage=""
          label="novel run"
        >
          {status.data ? (
            <RunPanel
              key={projectId}
              projectId={projectId}
              data={status.data}
              onChanged={() => {
                status.reload();
              }}
              onEditIntake={() => setEditingIntake(true)}
            />
          ) : null}
        </AsyncRegion>
      )}
    </section>
  );
}

export function IntakeForm({
  projectId,
  onStarted,
  onCancel,
}: {
  projectId: string;
  onStarted: () => void;
  onCancel?: (() => void) | undefined;
}): ReactNode {
  const { api, can } = useAppState();
  const start = useMutation();
  const intakeKey = useRef<string | undefined>(undefined);
  const intakeFingerprint = useRef<string | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [genre, setGenre] = useState<string>('hunter-gate');
  const [secondary, setSecondary] = useState('');
  const [secondary2, setSecondary2] = useState('');
  const [mainName, setMainName] = useState('');
  const [mainRole, setMainRole] = useState('');
  const [mainDescription, setMainDescription] = useState('');
  const [supporting, setSupporting] = useState('');
  const [world, setWorld] = useState('');
  const [settingType, setSettingType] = useState<
    'modern_korea' | 'secondary_world' | 'murim_historical' | 'other'
  >('secondary_world');
  const [tropes, setTropes] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [mandatory, setMandatory] = useState('');
  const [restrictions, setRestrictions] = useState('');
  const [progression, setProgression] = useState('');
  const [romance, setRomance] = useState<'none' | 'subplot' | 'main'>('subplot');
  const [romancePace, setRomancePace] = useState<'slow_burn' | 'medium' | 'fast'>('slow_burn');
  const [romanceDynamic, setRomanceDynamic] = useState('');
  const [ending, setEnding] = useState<'happy' | 'bittersweet' | 'open' | 'tragic' | 'unspecified'>(
    'happy',
  );
  const [rating, setRating] = useState<'all' | '12' | '15' | '19'>('15');
  const [pace, setPace] = useState<'fast' | 'medium' | 'slow'>('fast');
  const [ciderLevel, setCiderLevel] = useState<'high_cider' | 'balanced' | 'struggle'>('balanced');
  const [chapters, setChapters] = useState('30');
  const [words, setWords] = useState('2500');
  const [tone, setTone] = useState('');
  const [announcement, setAnnouncement] = useState('');

  if (!can('editor'))
    return <p className="note">Starting a novel requires the editor role in this workspace.</p>;

  const submit = () => {
    start.run(async () => {
      const secondaryGenres = [secondary, secondary2].filter(Boolean);
      const romanceConstraints = romanceDynamic.trim() ? [romanceDynamic.trim()] : [];
      const toneKeywords = [
        ...lines(tone),
        ciderLevel === 'high_cider'
          ? 'high cider / fast payoff (사이다)'
          : ciderLevel === 'balanced'
            ? 'balanced catharsis'
            : 'gritty struggle',
      ];

      const intake: Record<string, unknown> = {
        title_working: title.trim(),
        premise: premise.trim(),
        genre: {
          primary: genre,
          ...(secondaryGenres.length ? { secondary: secondaryGenres } : {}),
        },
        ...(mainName.trim() || mainRole.trim() || mainDescription.trim()
          ? {
              main_character: {
                name: mainName.trim() || 'Protagonist',
                ...(mainRole.trim() ? { role: mainRole.trim() } : {}),
                ...(mainDescription.trim() ? { description: mainDescription.trim() } : {}),
              },
            }
          : {}),
        ...(lines(supporting).length
          ? {
              supporting_characters: lines(supporting).map((l) => {
                const [name, ...rest] = l.split(/\s[—–-]\s|:\s/);
                return {
                  name: (name ?? l).trim(),
                  ...(rest.length ? { description: rest.join(' ').trim() } : {}),
                };
              }),
            }
          : {}),
        ...(world.trim() || settingType
          ? {
              ...(world.trim() ? { world_concept: world.trim() } : {}),
              setting_preferences: {
                setting_type: settingType,
                ...(world.trim() ? { notes: world.trim() } : {}),
              },
            }
          : {}),
        ...(lines(tropes).length ? { desired_tropes: lines(tropes) } : {}),
        ...(lines(forbidden).length ? { forbidden_developments: lines(forbidden) } : {}),
        ...(lines(mandatory).length
          ? { mandatory_scenes: lines(mandatory).map((description) => ({ description })) }
          : {}),
        ...(lines(restrictions).length ? { content_restrictions: lines(restrictions) } : {}),
        ...(progression.trim() ? { progression_system: progression.trim() } : {}),
        romance: {
          presence: romance,
          ...(romance !== 'none' ? { pace: romancePace } : {}),
          ...(romanceConstraints.length ? { constraints: romanceConstraints } : {}),
        },
        ending_preference: ending,
        target_audience: { rating },
        tone: { pace, ...(toneKeywords.length ? { keywords: toneKeywords } : {}) },
        target_chapters: Number(chapters),
        target_words_per_chapter: Number(words),
        operating_mode: 'autopilot',
      };
      const fingerprint = JSON.stringify(intake);
      if (intakeFingerprint.current !== fingerprint) {
        intakeKey.current = newIdempotencyKey();
        intakeFingerprint.current = fingerprint;
      }
      await api.post(`/v1/projects/${projectId}/novel`, { intake }, intakeKey.current);
      intakeKey.current = undefined;
      intakeFingerprint.current = undefined;
      setAnnouncement('Story suggestions are ready for review.');
      onStarted();
    });
  };

  return (
    <section aria-labelledby="intake-heading">
      <h2 id="intake-heading">Describe the novel you want</h2>
      <p className="note">
        The studio interprets these details into a story specification, proposes a few story
        directions, and — once you approve one — builds the complete story bible (cast, world,
        progression system, series blueprint) before writing a single chapter.
      </p>
      <LiveRegion message={announcement} />
      {start.error ? (
        <ErrorSummary
          title={
            start.problem?.problem.code === 'NO_PROVIDER'
              ? 'No model provider is configured'
              : 'Could not start the novel'
          }
          message={start.error}
        />
      ) : null}
      <Form label="Start a novel" onSubmit={submit}>
        <Field path="novel-title" label="Working title">
          {(p) => (
            <input
              {...p}
              required
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          path="novel-premise"
          label="Premise"
          hint="Two to five sentences. Any language; the manuscript is always English."
        >
          {(p) => (
            <textarea
              {...p}
              required
              minLength={20}
              rows={5}
              value={premise}
              onChange={(e) => {
                setPremise(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-genre" label="Primary genre">
          {(p) => (
            <select
              {...p}
              value={genre}
              onChange={(e) => {
                setGenre(e.target.value);
              }}
            >
              {GENRES.map((g) => (
                <option key={g} value={g}>
                  {GENRE_LABELS[g] ?? g}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field path="novel-secondary" label="Secondary genre 1 (optional)">
          {(p) => (
            <select
              {...p}
              value={secondary}
              onChange={(e) => {
                setSecondary(e.target.value);
              }}
            >
              <option value="">none</option>
              {GENRES.filter((g) => g !== genre).map((g) => (
                <option key={g} value={g}>
                  {GENRE_LABELS[g] ?? g}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field path="novel-secondary2" label="Secondary genre 2 (optional)">
          {(p) => (
            <select
              {...p}
              value={secondary2}
              onChange={(e) => {
                setSecondary2(e.target.value);
              }}
            >
              <option value="">none</option>
              {GENRES.filter((g) => g !== genre && g !== secondary).map((g) => (
                <option key={g} value={g}>
                  {GENRE_LABELS[g] ?? g}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field path="novel-chapters" label="Number of chapters">
          {(p) => (
            <input
              {...p}
              type="number"
              min={1}
              max={5000}
              required
              value={chapters}
              onChange={(e) => {
                setChapters(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-words" label="Words per chapter">
          {(p) => (
            <input
              {...p}
              type="number"
              min={500}
              max={8000}
              required
              value={words}
              onChange={(e) => {
                setWords(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-main-name" label="Main character name (optional)">
          {(p) => (
            <input
              {...p}
              value={mainName}
              onChange={(e) => {
                setMainName(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          path="novel-main-role"
          label="Main character role / archetype (optional)"
          hint="e.g. Disregarded Extra, Hidden Regressor, Transmigrated Reader, Academy Underdog, Calculative Strategist"
        >
          {(p) => (
            <input
              {...p}
              value={mainRole}
              onChange={(e) => {
                setMainRole(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-main-desc" label="Main character notes (optional)">
          {(p) => (
            <textarea
              {...p}
              rows={2}
              value={mainDescription}
              onChange={(e) => {
                setMainDescription(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          path="novel-supporting"
          label="Supporting characters (optional)"
          hint="One per line: Name — notes"
        >
          {(p) => (
            <textarea
              {...p}
              rows={3}
              value={supporting}
              onChange={(e) => {
                setSupporting(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-setting-type" label="Setting world type">
          {(p) => (
            <select
              {...p}
              value={settingType}
              onChange={(e) => {
                setSettingType(e.target.value as typeof settingType);
              }}
            >
              <option value="secondary_world">Fantasy Secondary World / Magic Realm (이세계/정통판타지)</option>
              <option value="modern_korea">Modern Korea / Neo-Seoul (현대물/헌터)</option>
              <option value="murim_historical">Murim / Historical Martial Realm (무협/동양풍)</option>
              <option value="other">Other / Multi-realm / Dimensional (기타)</option>
            </select>
          )}
        </Field>
        <Field path="novel-world" label="World concept notes (optional)">
          {(p) => (
            <textarea
              {...p}
              rows={3}
              value={world}
              onChange={(e) => {
                setWorld(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-progression" label="Progression / power system (optional)">
          {(p) => (
            <textarea
              {...p}
              rows={2}
              value={progression}
              onChange={(e) => {
                setProgression(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-tropes" label="Desired tropes (optional)" hint="One per line">
          {(p) => (
            <textarea
              {...p}
              rows={3}
              value={tropes}
              onChange={(e) => {
                setTropes(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          path="novel-forbidden"
          label="Forbidden developments (optional)"
          hint="One per line. Each becomes a hard rule every plan and chapter must obey."
        >
          {(p) => (
            <textarea
              {...p}
              rows={3}
              value={forbidden}
              onChange={(e) => {
                setForbidden(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-mandatory" label="Mandatory scenes (optional)" hint="One per line">
          {(p) => (
            <textarea
              {...p}
              rows={2}
              value={mandatory}
              onChange={(e) => {
                setMandatory(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          path="novel-restrictions"
          label="Content restrictions (optional)"
          hint="One per line"
        >
          {(p) => (
            <textarea
              {...p}
              rows={2}
              value={restrictions}
              onChange={(e) => {
                setRestrictions(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-tone" label="Tone keywords (optional)" hint="One per line">
          {(p) => (
            <textarea
              {...p}
              rows={2}
              value={tone}
              onChange={(e) => {
                setTone(e.target.value);
              }}
            />
          )}
        </Field>
        <Field path="novel-pace" label="Pace">
          {(p) => (
            <select
              {...p}
              value={pace}
              onChange={(e) => {
                setPace(e.target.value as typeof pace);
              }}
            >
              <option value="fast">fast</option>
              <option value="medium">medium</option>
              <option value="slow">slow</option>
            </select>
          )}
        </Field>
        <Field path="novel-romance" label="Romance">
          {(p) => (
            <select
              {...p}
              value={romance}
              onChange={(e) => {
                setRomance(e.target.value as typeof romance);
              }}
            >
              <option value="none">none</option>
              <option value="subplot">subplot (recommended for webnovels)</option>
              <option value="main">main plot</option>
            </select>
          )}
        </Field>
        {romance !== 'none' ? (
          <>
            <Field path="novel-romance-pace" label="Romance pace">
              {(p) => (
                <select
                  {...p}
                  value={romancePace}
                  onChange={(e) => {
                    setRomancePace(e.target.value as typeof romancePace);
                  }}
                >
                  <option value="slow_burn">
                    Slow Burn (Deliberate build-up, emotional tension, slow realization)
                  </option>
                  <option value="medium">
                    Medium (Steady romantic progression alongside main plot)
                  </option>
                  <option value="fast">Fast (Early mutual attraction & partnership)</option>
                </select>
              )}
            </Field>
            <Field
              path="novel-romance-dynamic"
              label="Romance dynamic / constraints (optional)"
              hint="e.g. Strict single love interest (no harem), Enemies to reluctant allies, Contract bond, Reluctant savior"
            >
              {(p) => (
                <input
                  {...p}
                  value={romanceDynamic}
                  onChange={(e) => {
                    setRomanceDynamic(e.target.value);
                  }}
                />
              )}
            </Field>
          </>
        ) : null}
        <Field path="novel-cider" label="Catharsis & tension balance (사이다 / 고구마)">
          {(p) => (
            <select
              {...p}
              value={ciderLevel}
              onChange={(e) => {
                setCiderLevel(e.target.value as typeof ciderLevel);
              }}
            >
              <option value="high_cider">
                High Cider (사이다) — Fast decisive payoffs, zero prolonged passive suffering
              </option>
              <option value="balanced">
                Balanced Catharsis — Deepening stakes & challenges with earned satisfying releases
              </option>
              <option value="struggle">
                Gritty Struggle — High stakes, hard-earned underdog victories against overwhelming odds
              </option>
            </select>
          )}
        </Field>
        <Field path="novel-ending" label="Ending">
          {(p) => (
            <select
              {...p}
              value={ending}
              onChange={(e) => {
                setEnding(e.target.value as typeof ending);
              }}
            >
              <option value="happy">happy (recommended for Korean webnovels)</option>
              <option value="bittersweet">bittersweet</option>
              <option value="open">open</option>
              <option value="tragic">tragic</option>
              <option value="unspecified">let the studio decide</option>
            </select>
          )}
        </Field>
        <Field path="novel-rating" label="Audience rating">
          {(p) => (
            <select
              {...p}
              value={rating}
              onChange={(e) => {
                setRating(e.target.value as typeof rating);
              }}
            >
              <option value="all">all</option>
              <option value="12">12+</option>
              <option value="15">15+</option>
              <option value="19">19+</option>
            </select>
          )}
        </Field>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button type="submit" disabled={start.busy}>
            {start.busy ? 'Thinking of story directions…' : 'Get story suggestions'}
          </button>
          {onCancel ? (
            <button type="button" onClick={onCancel} disabled={start.busy}>
              Cancel
            </button>
          ) : null}
        </div>
      </Form>
    </section>
  );
}

function RunPanel({
  projectId,
  data,
  onChanged,
  onEditIntake,
}: {
  projectId: string;
  data: NovelStatus;
  onChanged: () => void;
  onEditIntake?: (() => void) | undefined;
}): ReactNode {
  const { api, can } = useAppState();
  const act = useMutation();
  const approvalKeys = useRef(new Map<string, { key: string; fingerprint: string }>());
  const confirm = useConfirm();
  const [announcement, setAnnouncement] = useState('');
  const [fullBible, setFullBible] = useState<FullBibleResponse | undefined>(undefined);
  const [fullBibleLoading, setFullBibleLoading] = useState(false);
  const [fullBibleError, setFullBibleError] = useState<string | undefined>(undefined);
  const [autoContinue, setAutoContinue] = useState(true);
  const run = data.run;
  const accepted = data.accepted_chapters;
  const percent = Math.round((accepted / Math.max(1, run.target_chapters)) * 100);

  const loadFullBible = async () => {
    setFullBibleLoading(true);
    setFullBibleError(undefined);
    try {
      setFullBible(await api.get<FullBibleResponse>(`/v1/projects/${projectId}/novel/bible`));
    } catch (error) {
      setFullBibleError(
        error instanceof ApiProblem
          ? messageFor(error.problem)
          : 'Unable to load the full story bible.',
      );
    } finally {
      setFullBibleLoading(false);
    }
  };

  const downloadFullBible = () => {
    if (!fullBible) return;
    const blob = new Blob([JSON.stringify(fullBible, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `story-bible-${projectId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const control = (action: 'pause' | 'resume' | 'cancel') => {
    act.run(async () => {
      await api.post(`/v1/projects/${projectId}/novel/${action}`, {}, newIdempotencyKey());
      setAnnouncement(`Run ${action} requested.`);
      onChanged();
    });
  };

  return (
    <section aria-labelledby="run-heading">
      <h2 id="run-heading">
        Novel run{' '}
        <StatusBadge
          label={runStatusLabel(run.status)}
          tone={runTone(run.status)}
          {...(run.running ? { detail: 'working now' } : {})}
        />
      </h2>
      <LiveRegion message={announcement} />
      <ConfirmDialog
        open={confirm.open}
        title="Cancel this novel run?"
        impact={<p>Accepted chapters and canon are kept; nothing further will be written.</p>}
        confirmLabel="Cancel the run"
        onCancel={() => {
          confirm.resolve(false);
        }}
        onConfirm={() => {
          confirm.resolve(true, () => {
            control('cancel');
          });
        }}
      />
      {act.error ? <ErrorSummary message={act.error} /> : null}
      {run.last_error ? (
        <ErrorSummary
          title={`Stopped at ${run.last_error.step ?? 'a step'} (${run.last_error.code ?? 'error'})`}
          message={
            run.last_error.message ?? 'The run stopped. Resume to retry from the last checkpoint.'
          }
        />
      ) : null}

      <dl className="kv">
        <dt>Chapters accepted</dt>
        <dd>
          {accepted} / {run.target_chapters}
          <progress
            aria-label="chapters accepted"
            value={accepted}
            max={run.target_chapters}
          />{' '}
          {percent}%
        </dd>
        <dt>Next chapter</dt>
        <dd>{run.next_chapter > run.target_chapters ? 'done' : run.next_chapter}</dd>
        <dt>Mode</dt>
        <dd>{run.auto_continue ? 'autopilot (write every chapter)' : 'one chapter at a time'}</dd>
        <dt>Spend so far</dt>
        <dd>${(data.spend_cents / 100).toFixed(2)}</dd>
      </dl>

      {data.plan ? (
        <section aria-labelledby="full-bible-heading">
          <h3 id="full-bible-heading">Full story bible</h3>
          <p className="note">
            The complete cast, world, progression design, entities, propositions, promises, and
            commits are loaded only when requested so normal run polling stays small.
          </p>
          <button type="button" onClick={() => void loadFullBible()} disabled={fullBibleLoading}>
            {fullBibleLoading ? 'Loading full story bible…' : 'Load full story bible'}
          </button>
          {fullBibleError ? <ErrorSummary message={fullBibleError} /> : null}
          {fullBible ? (
            <>
              <button type="button" onClick={downloadFullBible}>
                Download full story bible (JSON)
              </button>
              <details open>
                <summary>Inspect full story bible and series blueprint</summary>
                <pre>{JSON.stringify(fullBible, null, 2)}</pre>
              </details>
            </>
          ) : null}
        </section>
      ) : null}

      {run.status === 'awaiting_approval' ? (
        <section aria-labelledby="suggestions-heading">
          <h3 id="suggestions-heading">Story suggestions — pick one to approve</h3>
          {can('editor') ? (
            <p className="field">
              <label>
                <input
                  type="checkbox"
                  checked={autoContinue}
                  onChange={(e) => {
                    setAutoContinue(e.target.checked);
                  }}
                />{' '}
                Write every chapter automatically (autopilot). Untick to pause after each accepted
                chapter.
              </label>
            </p>
          ) : null}
          <ul className="compare-grid">
            {data.suggestions.map((s, i) => (
              <li key={s.id ?? s.candidate_id ?? String(i)} data-status={s.status ?? 'candidate'}>
                <article aria-labelledby={`suggestion-${i}`}>
                  <h4 id={`suggestion-${i}`}>
                    Direction {i + 1}
                    {s.angle ? <span className="note"> — {s.angle}</span> : null}
                  </h4>
                  <p>
                    <strong>{s.logline}</strong>
                  </p>
                  <dl className="kv">
                    {s.story_promise ? (
                      <>
                        <dt>Story promise</dt>
                        <dd>{s.story_promise}</dd>
                      </>
                    ) : null}
                    {s.reader_fantasy ? (
                      <>
                        <dt>Reader fantasy</dt>
                        <dd>{s.reader_fantasy}</dd>
                      </>
                    ) : null}
                    {s.main_conflict ? (
                      <>
                        <dt>Main conflict</dt>
                        <dd>{s.main_conflict}</dd>
                      </>
                    ) : null}
                    {s.chapter_one_hook ? (
                      <>
                        <dt>Chapter one hook</dt>
                        <dd>{s.chapter_one_hook}</dd>
                      </>
                    ) : null}
                    {s.ending_direction ? (
                      <>
                        <dt>Ending direction</dt>
                        <dd>{s.ending_direction}</dd>
                      </>
                    ) : null}
                    {s.progression_curve ? (
                      <>
                        <dt>Progression</dt>
                        <dd>{s.progression_curve}</dd>
                      </>
                    ) : null}
                  </dl>
                  {s.differentiators?.length ? (
                    <p className="note">What makes it different: {s.differentiators.join('; ')}</p>
                  ) : null}
                  {s.risk_notes?.length ? (
                    <p className="note">Risks: {s.risk_notes.join('; ')}</p>
                  ) : null}
                  {can('editor') ? (
                    <button
                      type="button"
                      disabled={act.busy}
                      onClick={() => {
                        const conceptId = s.id ?? s.candidate_id;
                        if (!conceptId) return;
                        act.run(async () => {
                          const body = { concept_id: conceptId, auto_continue: autoContinue };
                          const fingerprint = JSON.stringify(body);
                          const previous = approvalKeys.current.get(conceptId);
                          const key =
                            previous?.fingerprint === fingerprint
                              ? previous.key
                              : newIdempotencyKey();
                          approvalKeys.current.set(conceptId, { key, fingerprint });
                          await api.post(`/v1/projects/${projectId}/novel/approve`, body, key);
                          approvalKeys.current.delete(conceptId);
                          setAnnouncement(
                            `Direction ${i + 1} approved. The studio is building the story bible.`,
                          );
                          onChanged();
                        });
                      }}
                    >
                      Approve direction {i + 1} and start writing
                    </button>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.plan ? (
        <section aria-labelledby="bible-heading">
          <h3 id="bible-heading">Story bible</h3>
          {data.plan.blueprint ? (
            <dl className="kv">
              <dt>Story promise</dt>
              <dd>{data.plan.blueprint.story_promise}</dd>
              <dt>Main conflict</dt>
              <dd>{data.plan.blueprint.main_conflict}</dd>
              <dt>Ending</dt>
              <dd>
                {data.plan.blueprint.ending?.type ?? '—'}
                {data.plan.blueprint.ending?.summary
                  ? ` — ${data.plan.blueprint.ending.summary}`
                  : ''}
              </dd>
            </dl>
          ) : null}
          {data.plan.blueprint?.seasons.length ? (
            <>
              <h4>Seasons</h4>
              <ol>
                {data.plan.blueprint.seasons.map((s) => (
                  <li key={s.ordinal}>
                    <strong>{s.title}</strong> (ch. {s.chapters.from}–{s.chapters.to}):{' '}
                    {s.objective}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {data.plan.bible ? (
            <>
              <h4>Cast ({data.plan.bible.characters.length})</h4>
              <ul className="card-list">
                {data.plan.bible.characters.map((c) => (
                  <li key={c.name}>
                    <strong>{c.name}</strong>
                    {c.description ? ` — ${c.description}` : ''}
                  </li>
                ))}
              </ul>
              <p className="note">
                {data.plan.bible.locations.length} locations ·{' '}
                {data.plan.bible.organizations.length} organizations ·{' '}
                {data.plan.bible.abilities.length} abilities · {data.plan.bible.propositions}{' '}
                propositions · {data.plan.bible.promises.length} promises
              </p>
              {data.plan.bible.promises.length ? (
                <>
                  <h4>Promises the series owes</h4>
                  <ul>
                    {data.plan.bible.promises.map((p) => (
                      <li key={p.statement}>
                        {p.statement} <StatusBadge label={p.type} detail={p.importance} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {data.chapters.length ? (
        <section aria-labelledby="chapters-progress-heading">
          <h3 id="chapters-progress-heading">Chapters</h3>
          <table>
            <caption>Chapter progress</caption>
            <thead>
              <tr>
                <th scope="col">Chapter</th>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.chapters.map((c) => (
                <tr key={c.number}>
                  <th scope="row">{c.number}</th>
                  <td>{c.title ?? '—'}</td>
                  <td>
                    <StatusBadge
                      label={c.status}
                      tone={c.status === 'accepted' ? 'good' : 'progress'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {can('editor') ? (
        <p className="actions">
          {run.status === 'planning' || run.status === 'producing' ? (
            <button
              type="button"
              disabled={act.busy}
              onClick={() => {
                control('pause');
              }}
            >
              Pause after the current step
            </button>
          ) : null}
          {run.status === 'paused' ||
          run.status === 'needs_attention' ||
          run.status === 'failed' ? (
            <button
              type="button"
              disabled={act.busy}
              onClick={() => {
                control('resume');
              }}
            >
              Resume from the last checkpoint
            </button>
          ) : null}
          {(run.status === 'awaiting_approval' ||
            run.status === 'failed' ||
            run.status === 'cancelled') &&
          onEditIntake ? (
            <button
              type="button"
              disabled={act.busy}
              onClick={onEditIntake}
            >
              Modify intake & get fresh suggestions
            </button>
          ) : null}
          {can('owner') && !['completed', 'cancelled'].includes(run.status) ? (
            <button
              type="button"
              disabled={act.busy}
              onClick={(event) => {
                confirm.request(event.currentTarget);
              }}
            >
              Cancel run
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

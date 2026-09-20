/**
 * Planning steps of the vertical slice: intake validation → `requirement_interpreter` → versioned Story Spec
 * (hard / soft / assumption kept distinct, assumptions explained) → Story Bible (entities, propositions,
 * promises and the bible canon commit) → initial arc plan → Chapter Contract → contract validation + lock.
 *
 * The bible and the plans are PLANNED artifacts: they live in workflow_artifacts and in the bible commit
 * (`source='bible'`, no story events), never as realized canon (ADR-0038: planned ≠ happened).
 */
import {
  commitDelta,
  checkpointControl,
  createChapter,
  createEntity,
  createPromise,
  getProject,
  JobControlCommitBlockedError,
  chapterByNumber,
} from '@yeonjae/db';
import { type Generated, validatorFor } from '@yeonjae/domain';
import { compileActiveConstraintSet } from '@yeonjae/context';
import { compileBlock } from '@yeonjae/narrative';
import { WorkflowError } from './errors.js';
import {
  bind,
  existingArtifact,
  modelCall,
  runStep,
  saveArtifact,
  substitute,
  type WorkflowContext,
} from './runtime.js';

export type StoryIntake = Generated.StoryIntakeSchema.StoryIntake;
export type StorySpec = Generated.StorySpecSchema.StorySpec;
export type Requirement = Generated.StorySpecSchema.Requirement;
export type ArcPlan = Generated.ArcPlanSchema.ArcPlan;
export type ChapterContract = Generated.ChapterContractSchema.ChapterContract;

/** The Story Bible as the slice needs it: registry entities, propositions, promises, seed facts/relations. */
export interface StoryBible {
  readonly version: number;
  readonly design?:
    | {
        readonly characters: Readonly<Record<string, unknown>>;
        readonly world: Readonly<Record<string, unknown>>;
        readonly progression: Readonly<Record<string, unknown>>;
      }
    | undefined;
  readonly entities: readonly {
    readonly id: string;
    readonly type: string;
    readonly display_name: string;
    readonly short_forms?: readonly string[] | undefined;
    readonly aliases?: readonly string[] | undefined;
    readonly description?: string | undefined;
    readonly design?: Readonly<Record<string, unknown>> | undefined;
  }[];
  readonly propositions: readonly {
    readonly local_id: string;
    readonly statement: string;
    readonly kind: string;
    readonly entity_ids: readonly string[];
    readonly secret?: Record<string, unknown> | undefined;
    readonly truth: 'true' | 'false' | 'unknown';
  }[];
  readonly promises: readonly {
    readonly id: string;
    readonly type: string;
    readonly statement: string;
    readonly importance: 'core' | 'major' | 'minor';
    readonly due_min_chapter?: number | undefined;
    readonly due_max_chapter?: number | undefined;
    readonly related_entity_ids: readonly string[];
  }[];
  /**
   * Seed facts / relationships / knowledge committed as `bible` commits (payloads per canon-delta-payloads).
   * Items may reference ids created earlier in the run as `{{proposition.P1}}`, `{{bible.<local_id>}}`,
   * `{{chapter.1}}`; commits run in order so later ones can cite earlier ones.
   */
  readonly commits: readonly (readonly Record<string, unknown>[])[];
}

export interface PlanningResult {
  readonly spec: StorySpec;
  readonly specArtifactId: string;
  readonly bible: StoryBible;
  readonly bibleCanonVersion: number;
  readonly propositionIds: Readonly<Record<string, string>>;
  readonly arcPlan: ArcPlan;
  readonly contract: ChapterContract;
  readonly contractArtifactId: string;
}

export function validateIntake(intake: unknown): StoryIntake {
  const v = validatorFor<StoryIntake>('story-intake.schema.json')(intake);
  if (!v.ok)
    throw new WorkflowError(
      'INTAKE_INVALID',
      v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      { step: 'intake', recommendedActions: ['edit_manually'] },
    );
  return v.value;
}

/** The chapter row exists from the start of the run so bible knowledge sources and bindings can cite it. */
export async function ensureChapter(ctx: WorkflowContext, chapterNo: number): Promise<string> {
  const existing = await chapterByNumber(ctx.pool, ctx.projectId, chapterNo);
  const id =
    existing?.id ??
    (await createChapter(ctx.pool, {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      number: chapterNo,
    }));
  await bind(ctx, { [`chapter.${chapterNo}`]: id });
  return id;
}

export async function interpretRequirements(
  ctx: WorkflowContext,
  intake: StoryIntake,
  specVersion: number,
): Promise<{ spec: StorySpec; artifactId: string }> {
  return runStep(
    ctx,
    'story_spec',
    async () => {
    await bind(ctx, { spec_version: String(specVersion) });
    // The spec is a PROJECT artifact: the story plan (or chapter 1) interpreted it once and every later
    // chapter job pins that same version rather than asking the model again.
    const stored = await existingArtifact(ctx, {
      step: 'story_spec',
      kind: 'story_spec',
      key: `v${specVersion}`,
    });
    if (stored) return { spec: stored.payload as StorySpec, artifactId: stored.artifact_id };
    const call = await modelCall<{ items?: unknown; conflicts?: unknown }>(ctx, {
      step: 'story_spec',
      family: 'requirement_interpreter',
      activityId: `story_spec:v${specVersion}`,
      variables: {
        intake_json: JSON.stringify(intake),
        spelling_locale: intake.spelling_locale ?? 'en-US',
      },
    });
    const raw = call.output;
    const VALID_CATEGORIES = new Set([
      'genre', 'premise', 'character', 'world', 'progression', 'romance',
      'tone', 'ending', 'structure', 'length', 'mandatory_scene',
      'forbidden_development', 'content_restriction', 'style', 'audience',
      'direction', 'other'
    ]);
    const normalizeCategory = (cat: string): string => {
      if (VALID_CATEGORIES.has(cat)) return cat;
      const lower = cat.toLowerCase();
      if (lower.includes('romance')) return 'romance';
      if (lower.includes('premise')) return 'premise';
      if (lower.includes('tone') || lower.includes('pacing')) return 'tone';
      if (lower.includes('metric') || lower.includes('length')) return 'length';
      if (lower.includes('rating') || lower.includes('restriction')) return 'content_restriction';
      if (lower.includes('genre')) return 'genre';
      return 'other';
    };
    const VALID_LEVELS = new Set(['series', 'season', 'arc', 'chapter_range', 'character', 'relationship']);
    const normalizeLevel = (lvl: unknown): Requirement['scope']['level'] => {
      if (typeof lvl === 'string' && VALID_LEVELS.has(lvl)) return lvl as Requirement['scope']['level'];
      return 'series';
    };
    const rawItems = (Array.isArray(raw.items) ? raw.items : (Array.isArray((raw as any).requirements) ? (raw as any).requirements : [])) as Record<string, any>[];
    const items: Requirement[] = rawItems.map((r, idx) => {
      const rawScope = typeof r.scope === 'object' && r.scope ? r.scope : {};
      const level = normalizeLevel(rawScope.level);
      const cleanScope: Requirement['scope'] = { level };
      if (Array.isArray(rawScope.season_ids)) cleanScope.season_ids = rawScope.season_ids;
      if (Array.isArray(rawScope.arc_ids)) cleanScope.arc_ids = rawScope.arc_ids;
      if (typeof rawScope.chapter_from === 'number' && rawScope.chapter_from >= 1) cleanScope.chapter_from = Math.floor(rawScope.chapter_from);
      if (typeof rawScope.chapter_to === 'number' && rawScope.chapter_to >= 1) cleanScope.chapter_to = Math.floor(rawScope.chapter_to);
      if (Array.isArray(rawScope.entity_ids)) cleanScope.entity_ids = rawScope.entity_ids;
      return {
        id: typeof r.id === 'string' && /^REQ-[0-9]{3,5}$/.test(r.id) ? r.id : `REQ-${String(idx + 1).padStart(3, '0')}`,
        kind: (['hard', 'soft', 'assumption'].includes(r.kind) ? r.kind : 'hard') as Requirement['kind'],
        category: normalizeCategory(String(r.category || 'other')) as Requirement['category'],
        text: String(r.text || r.statement || r.description || ''),
        language: String(r.language || 'en'),
        provenance: (['user', 'system_default', 'model_inferred'].includes(r.provenance) ? r.provenance : 'user') as Requirement['provenance'],
        scope: cleanScope,
        ...(r.kind === 'assumption' ? { rationale: String(r.rationale || r.statement || 'Assumed default for series consistency') } : {}),
        ...(r.structured && typeof r.structured === 'object' ? { structured: r.structured } : {}),
      };
    });
    const rawConflicts = Array.isArray(raw.conflicts) ? raw.conflicts : [];
    const validConflicts = rawConflicts
      .filter((c: any) => c && Array.isArray(c.item_ids) && c.item_ids.length >= 2 && c.description)
      .map((c: any) => ({
        item_ids: c.item_ids.map(String),
        description: String(c.description),
        status: (c.status === 'resolved' ? 'resolved' : 'open') as 'open' | 'resolved',
        ...(c.resolution ? { resolution: String(c.resolution) } : {}),
      }));
    const candidate: StorySpec = {
      project_id: ctx.projectId,
      version: specVersion,
      items,
      ...(validConflicts.length > 0 ? { conflicts: validConflicts } : {}),
    };
    const v = validatorFor<StorySpec>('story-spec.schema.json')(candidate);
    if (!v.ok)
      throw new WorkflowError(
        'SPEC_INVALID',
        v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        { step: 'story_spec', recommendedActions: ['regenerate'] },
      );
    const spec = v.value;
    // Hard / soft / assumption are distinct by construction; every assumption must carry a rationale.
    const assumptions = spec.items.filter((i) => i.kind === 'assumption');
    const unexplained = assumptions.filter((a) => !a.rationale);
    let explained = spec;
    if (unexplained.length > 0) {
      const expl = await modelCall<{
        explanations?: { assumption_id: string; rationale: string }[];
      }>(ctx, {
        step: 'story_spec',
        family: 'assumption_explainer',
        activityId: `assumptions:v${specVersion}`,
        variables: { assumptions_json: JSON.stringify(unexplained) },
      });
      const byId = new Map(
        (expl.output.explanations ?? []).map((e) => [e.assumption_id, e.rationale]),
      );
      explained = {
        ...spec,
        items: spec.items.map((i) =>
          i.kind === 'assumption' && !i.rationale && byId.get(i.id)
            ? { ...i, rationale: byId.get(i.id) ?? '' }
            : i,
        ),
      };
      const still = explained.items.filter((i) => i.kind === 'assumption' && !i.rationale);
      if (still.length > 0)
        throw new WorkflowError(
          'SPEC_INVALID',
          `assumptions without a recorded rationale: ${still.map((s) => s.id).join(', ')}`,
          { step: 'story_spec', recommendedActions: ['regenerate'] },
        );
    }
    for (const item of explained.items) {
      if (item.kind === 'assumption' && item.confirmed_by_user)
        throw new WorkflowError(
          'SPEC_INVALID',
          `${item.id}: an assumption cannot be marked confirmed_by_user; promote it to hard/soft instead`,
          { step: 'story_spec' },
        );
    }
    const ref = await saveArtifact(ctx, {
      step: 'story_spec',
      kind: 'story_spec',
      key: `v${specVersion}`,
      schema: 'story-spec.schema.json',
      payload: explained,
    });
    return { spec: explained, artifactId: ref.artifact_id };
  }, `v${specVersion}`);
}

/**
 * The bible is authored data in this slice (no `character_designer`/`world_builder` calls are needed to prove
 * the loop); it is validated structurally, its entities/promises are created with their fixture ids, and its
 * seed items are committed as the `bible` canon commit (version 0 → 1) exactly once.
 */
export async function buildStoryBible(
  ctx: WorkflowContext,
  bible: StoryBible,
  mainTimelineId: string,
): Promise<{ canonVersion: number; propositionIds: Record<string, string>; artifactId: string }> {
  return runStep(ctx, 'story_bible', async () => {
    if (bible.entities.length === 0)
      throw new WorkflowError('INTERNAL', 'story bible has no entities', { step: 'story_bible' });
    // `runStep` checks control before entering this callback, but the seed writes are a multi-statement
    // boundary. Re-check immediately before touching planned registry/canon state so a mid-step cancel
    // cannot proceed merely because the step itself is already marked running.
    await checkpointStoryBibleControl(ctx, 'story_bible_seed');
    const seen = new Set<string>();
    for (const e of bible.entities) {
      if (seen.has(e.display_name))
        throw new WorkflowError('INTERNAL', `duplicate bible entity ${e.display_name}`, {
          step: 'story_bible',
        });
      seen.add(e.display_name);
      const exists = await ctx.pool.query('SELECT 1 FROM entities WHERE id = $1', [e.id]);
      if (exists.rowCount === 0)
        await createEntity(ctx.pool, {
          id: e.id,
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          type: e.type,
          displayName: e.display_name,
          shortForms: [...(e.short_forms ?? [])],
          aliases: [...(e.aliases ?? [])],
          fields: {
            ...(e.description ? { description: e.description } : {}),
            ...(e.design ? { planned_design: e.design } : {}),
          },
        });
    }
    for (const p of bible.promises) {
      const exists = await ctx.pool.query('SELECT 1 FROM promises WHERE id = $1', [p.id]);
      if (exists.rowCount === 0)
        await createPromise(ctx.pool, {
          id: p.id,
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          type: p.type,
          statement: p.statement,
          importance: p.importance,
          status: 'planned',
          dueMinChapter: p.due_min_chapter,
          dueMaxChapter: p.due_max_chapter,
          relatedEntityIds: p.related_entity_ids,
        });
    }
    const propositionItems: Record<string, unknown>[] = bible.propositions.map((p) => ({
      local_id: p.local_id,
      type: 'proposition',
      op: 'create',
      frame: 'canonical',
      confidence: 1,
      importance: 'core',
      evidence: [],
      payload: {
        statement: p.statement,
        kind: p.kind,
        entity_ids: p.entity_ids,
        ...(p.secret ? { secret: p.secret } : {}),
        truth: [{ timeline_id: mainTimelineId, value: p.truth }],
      },
    }));
    const commits = [[...propositionItems, ...(bible.commits[0] ?? [])], ...bible.commits.slice(1)];
    const propositionIds: Record<string, string> = {};
    const bibleIds: Record<string, string> = {};
    const project = await getProject(ctx.pool, ctx.projectId);
    if (project.canon_version === 0) {
      let parent = 0;
      for (const items of commits) {
        await checkpointStoryBibleControl(ctx, 'story_bible_commit');
        let commit;
        try {
          commit = await commitDelta(ctx.pool, {
            projectId: ctx.projectId,
            parentVersion: parent,
            source: 'bible',
            delta: substitute({ items }, ctx.bindings),
            actor: { kind: 'workflow', workflow_id: ctx.workflowId },
            ...(ctx.lease ? { lease: ctx.lease } : {}),
            jobControl: { jobId: ctx.job.id },
          });
        } catch (err) {
          if (err instanceof JobControlCommitBlockedError)
            await checkpointStoryBibleControl(ctx, 'story_bible_commit');
          throw err;
        }
        parent = commit.version;
        for (const [local, id] of Object.entries(commit.item_ids)) {
          bibleIds[local] = id;
          if (bible.propositions.some((p) => p.local_id === local)) propositionIds[local] = id;
        }
        await bind(ctx, {
          ...Object.fromEntries(Object.entries(commit.item_ids).map(([k, v]) => [`bible.${k}`, v])),
          ...Object.fromEntries(
            Object.entries(propositionIds).map(([k, v]) => [`proposition.${k}`, v]),
          ),
        });
      }
    } else {
      // Resume after a crash between commit and checkpoint: recover ids from the bible commits.
      const rows = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM canon_commits WHERE project_id = $1 AND source = 'bible' ORDER BY version`,
        [ctx.projectId],
      );
      if (rows.rows.length === 0)
        throw new WorkflowError('CANON_STALE', 'canon is past version 0 but has no bible commit', {
          step: 'story_bible',
        });
      const props = await ctx.pool.query<{ id: string; statement: string }>(
        'SELECT id, statement FROM propositions WHERE project_id = $1',
        [ctx.projectId],
      );
      for (const p of bible.propositions) {
        const found = props.rows.find((x) => x.statement === p.statement);
        if (found) propositionIds[p.local_id] = found.id;
      }
      const stored = ctx.bindings;
      for (const [k, v] of Object.entries(stored))
        if (k.startsWith('bible.')) bibleIds[k.slice(6)] = v;
    }
    const after = await getProject(ctx.pool, ctx.projectId);
    const ref = await saveArtifact(ctx, {
      step: 'story_bible',
      kind: 'story_bible',
      key: `v${bible.version}`,
      payload: { ...bible, proposition_ids: propositionIds, bible_ids: bibleIds },
    });
    return { canonVersion: after.canon_version, propositionIds, artifactId: ref.artifact_id };
  });
}

async function checkpointStoryBibleControl(ctx: WorkflowContext, step: string): Promise<void> {
  await checkpointControl(ctx.pool, { jobId: ctx.job.id, step });
}

export async function planArc(
  ctx: WorkflowContext,
  input: {
    spec: StorySpec;
    bible: StoryBible;
    arcId: string;
    seasonId: string;
    targetChapters: number;
  },
): Promise<{ arcPlan: ArcPlan; artifactId: string }> {
  return runStep(ctx, 'arc_plan', async () => {
    const block = compilePlannerBlock(ctx);
    const call = await modelCall<ArcPlan>(ctx, {
      step: 'arc_plan',
      family: 'arc_planner',
      activityId: 'arc_plan:1',
      variables: {
        blueprint: `Series of ${input.targetChapters} chapters; season 1 opens on the awakening measurement.`,
        season: `Season 1 (id ${input.seasonId})`,
        arc_brief: `Arc 1 (id ${input.arcId}): the second awakening — the protagonist wakes on measurement morning with future knowledge and no proof.`,
        canon_state: renderBibleState(input.bible),
        open_promises: input.bible.promises
          .map((p) => `- ${p.statement} (${p.type}, ${p.importance})`)
          .join('\n'),
      },
      block,
    });
    const candidate = {
      ...call.output,
      project_id: ctx.projectId,
      id: input.arcId,
      season_id: input.seasonId,
    };
    const v = validatorFor<ArcPlan>('arc-plan.schema.json')(candidate);
    if (!v.ok)
      throw new WorkflowError(
        'ARC_PLAN_INVALID',
        v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        { step: 'arc_plan', recommendedActions: ['regenerate'] },
      );
    const ref = await saveArtifact(ctx, {
      step: 'arc_plan',
      kind: 'arc_plan',
      key: input.arcId,
      schema: 'arc-plan.schema.json',
      payload: v.value,
    });
    return { arcPlan: v.value, artifactId: ref.artifact_id };
  });
}

export interface ContractInput {
  readonly chapterNo: number;
  readonly spec: StorySpec;
  readonly arcPlan: ArcPlan;
  readonly mainTimelineId: string;
  readonly previousSummary: string;
  readonly lengthTargetWords: number;
  readonly contractId: string;
  /** Registry and promises rendered for the planner; absent falls back to the pinned-state notes. */
  readonly bible?: StoryBible | undefined;
}

/**
 * Generate, validate and lock the Chapter Contract. Validation is deterministic: schema, chapter number,
 * project/timeline pins, active-constraint-set hash recomputed from the pinned spec, no must_happen that a
 * hard forbidden-development requirement rules out for this chapter, and every guarded proposition known.
 */
export async function generateContract(
  ctx: WorkflowContext,
  input: ContractInput,
  knownPropositionIds: ReadonlySet<string>,
  knownEntityIds: ReadonlySet<string>,
): Promise<{ contract: ChapterContract; artifactId: string; chapterId: string }> {
  return runStep(
    ctx,
    'chapter_contract',
    async () => {
      const project = await getProject(ctx.pool, ctx.projectId);
      const block = compilePlannerBlock(ctx);
      const acsHard = compileActiveConstraintSet(
        input.spec,
        {
          chapterNo: input.chapterNo,
          arcId: input.arcPlan.id,
          seasonId: input.arcPlan.season_id,
          participantIds: [],
          specVersion: input.spec.version,
        },
        { capTokens: ctx.policy.context.active_constraints_cap_tokens },
      );
      await bind(ctx, {
        canon_version: String(project.canon_version),
        [`acs.${input.chapterNo}.id`]: acsHard.id,
        [`acs.${input.chapterNo}.hash`]: acsHard.contentHash,
        [`acs.${input.chapterNo}.tokens`]: String(acsHard.tokenCount),
      });
      const call = await modelCall<ChapterContract>(ctx, {
        step: 'chapter_contract',
        family: 'chapter_planner',
        activityId: `chapter_contract:${input.chapterNo}`,
        variables: {
          arc_plan: JSON.stringify(input.arcPlan),
          chapter_number: String(input.chapterNo),
          previous_chapter_summary: input.previousSummary,
          canon_state: input.bible
            ? `${renderBibleState(input.bible, ctx.bindings)}\n\nUse ONLY the entity ids above for participants, locations and pov.character_id, and ONLY the proposition ids above in knowledge_guards and knowledge_deltas. ${await renderCanonFacts(ctx, input.chapterNo)}`
            : '(structured canon is pinned by the workflow at contract validation)',
          knowledge_state: input.bible
            ? renderKnowledge(input.bible)
            : '(knowledge is pinned by the workflow at contract validation)',
          open_promises: input.bible
            ? input.bible.promises
                .map(
                  (p) =>
                    `- [${p.id}] ${p.statement} (${p.type}, ${p.importance}${p.due_min_chapter !== undefined ? `, due ch.${p.due_min_chapter}–${p.due_max_chapter ?? '?'}` : ''})`,
                )
                .join('\n') || '(none)'
            : '(promises are pinned by the workflow at contract validation)',
          active_constraints: acsHard.hardText,
          length_target_words: String(input.lengthTargetWords),
        },
        block,
      });
      const { candidate, acs } = normalizeChapterContract(
        call.output as Record<string, any>,
        input,
        ctx,
        project,
        knownPropositionIds,
        knownEntityIds,
      );
      const issues = validateContract(candidate, input, knownPropositionIds, knownEntityIds);
      if (issues.length > 0)
        throw new WorkflowError('CONTRACT_INVALID', issues.join('; '), {
          step: 'chapter_contract',
          data: { chapter_no: input.chapterNo, issues },
          recommendedActions: ['regenerate', 'revalidate_contract'],
        });
      const locked: ChapterContract = {
        ...candidate,
        status: 'locked',
        validation: {
          canon_ok: true,
          plan_ok: true,
          narrative_ok: true,
          issues: [],
          validated_at_canon_version: project.canon_version,
        },
      };
      const chapterId = await ensureChapter(ctx, input.chapterNo);
      await ctx.pool.query('UPDATE chapters SET title = coalesce(title, $2) WHERE id = $1', [
        chapterId,
        locked.purpose.slice(0, 80),
      ]);
      const ref = await saveArtifact(ctx, {
        step: 'chapter_contract',
        kind: 'chapter_contract',
        key: `${input.chapterNo}:v${locked.version}`,
        schema: 'chapter-contract.schema.json',
        payload: locked,
      });
      return { contract: locked, artifactId: ref.artifact_id, chapterId };
    },
    String(input.chapterNo),
  );
}

export function normalizeChapterContract(
  raw: Record<string, any> | undefined,
  input: ContractInput,
  ctx: WorkflowContext,
  project: { canon_version: number },
  knownPropositionIds: ReadonlySet<string>,
  knownEntityIds: ReadonlySet<string>,
): { candidate: ChapterContract; acs: ReturnType<typeof compileActiveConstraintSet> } {
  const r = raw ?? {};

  // Build entity lookup map from bible
  const nameToId = new Map<string, string>();
  let defaultProtagonistId: string | undefined;
  let defaultLocationId: string | undefined;

  if (input.bible?.entities) {
    for (const e of input.bible.entities) {
      nameToId.set(e.id.toLowerCase(), e.id);
      nameToId.set(e.display_name.toLowerCase(), e.id);
      for (const a of (e as any).aliases ?? []) {
        nameToId.set(String(a).toLowerCase(), e.id);
      }
      for (const s of (e as any).short_forms ?? []) {
        nameToId.set(String(s).toLowerCase(), e.id);
      }
      if (e.type === 'character' && !defaultProtagonistId) {
        defaultProtagonistId = e.id;
      }
      if (e.type === 'location' && !defaultLocationId) {
        defaultLocationId = e.id;
      }
    }
  }

  // Fallbacks if bible missing or incomplete
  if (!defaultProtagonistId) {
    for (const id of knownEntityIds) {
      defaultProtagonistId = id;
      break;
    }
  }
  if (!defaultLocationId) {
    defaultLocationId = defaultProtagonistId;
  }

  const resolveEntityId = (identifier: unknown, preferType?: 'character' | 'location'): string | undefined => {
    if (!identifier) return undefined;
    const str = String(identifier).trim();
    if (knownEntityIds.has(str)) return str;
    const lower = str.toLowerCase();
    if (nameToId.has(lower)) return nameToId.get(lower);

    // Partial matching on known bible entity names
    if (input.bible?.entities) {
      for (const e of input.bible.entities) {
        if (preferType && e.type !== preferType) continue;
        const eLower = e.display_name.toLowerCase();
        if (lower.includes(eLower) || eLower.includes(lower)) return e.id;
        for (const a of (e as any).aliases ?? []) {
          const aLower = String(a).toLowerCase();
          if (lower.includes(aLower) || aLower.includes(lower)) return e.id;
        }
      }
      if (preferType) {
        for (const e of input.bible.entities) {
          const eLower = e.display_name.toLowerCase();
          if (lower.includes(eLower) || eLower.includes(lower)) return e.id;
        }
      }
    }
    return undefined;
  };

  // 1. POV
  let povCharacterId: string | undefined;
  let povPerson: 'first' | 'third_limited' | 'third_omniscient' = 'third_limited';

  if (typeof r.pov === 'string') {
    povCharacterId = resolveEntityId(r.pov, 'character');
  } else if (r.pov && typeof r.pov === 'object') {
    povCharacterId = resolveEntityId(r.pov.character_id || r.pov.character || r.pov.name, 'character');
    if (['first', 'third_limited', 'third_omniscient'].includes(r.pov.person)) {
      povPerson = r.pov.person;
    }
  }
  if (!povCharacterId || !knownEntityIds.has(povCharacterId)) {
    povCharacterId = defaultProtagonistId!;
  }
  const pov: ChapterContract['pov'] = {
    character_id: povCharacterId,
    person: povPerson,
  };

  // 2. Participants
  const participantsMap = new Map<string, ChapterContract['participants'][number]>();
  participantsMap.set(pov.character_id, {
    character_id: pov.character_id,
    role_in_chapter: 'protagonist',
    on_page: true,
  });

  const validRoles = new Set([
    'protagonist', 'antagonist', 'ally', 'foil', 'cameo', 'love_interest', 'mentor', 'comic_relief',
  ]);

  if (Array.isArray(r.participants)) {
    for (const p of r.participants) {
      let cid: string | undefined;
      let role: any = 'ally';
      let onPage = true;
      if (typeof p === 'string') {
        cid = resolveEntityId(p, 'character');
      } else if (p && typeof p === 'object') {
        cid = resolveEntityId(p.character_id || p.character || p.name || p.id, 'character');
        if (validRoles.has(p.role_in_chapter)) role = p.role_in_chapter;
        if (typeof p.on_page === 'boolean') onPage = p.on_page;
      }
      if (cid && knownEntityIds.has(cid)) {
        if (!participantsMap.has(cid)) {
          participantsMap.set(cid, {
            character_id: cid,
            role_in_chapter: cid === pov.character_id ? 'protagonist' : role,
            on_page: onPage,
          });
        }
      }
    }
  }

  // Scan relationship_deltas for participants
  if (Array.isArray(r.relationship_deltas)) {
    for (const d of r.relationship_deltas) {
      if (typeof d?.pair === 'string') {
        const parts = d.pair.split(/[→\->,]/).map((s: string) => s.trim());
        for (const part of parts) {
          const cid = resolveEntityId(part, 'character');
          if (cid && knownEntityIds.has(cid) && !participantsMap.has(cid)) {
            participantsMap.set(cid, { character_id: cid, role_in_chapter: 'ally', on_page: true });
          }
        }
      }
    }
  }

  // Scan scenes for participants
  if (Array.isArray(r.scenes)) {
    for (const sc of r.scenes) {
      if (Array.isArray(sc.participants)) {
        for (const sp of sc.participants) {
          const cid = resolveEntityId(sp, 'character');
          if (cid && knownEntityIds.has(cid) && !participantsMap.has(cid)) {
            participantsMap.set(cid, { character_id: cid, role_in_chapter: 'ally', on_page: true });
          }
        }
      }
    }
  }

  // Ensure at least one participant is on_page
  const participantsList = Array.from(participantsMap.values());
  if (!participantsList.some((p) => p.on_page)) {
    participantsList[0]!.on_page = true;
  }
  const participants = participantsList as unknown as ChapterContract['participants'];

  // 3. Compile Active Constraint Set with normalized participantIds
  const acs = compileActiveConstraintSet(
    input.spec,
    {
      chapterNo: input.chapterNo,
      arcId: input.arcPlan.id,
      seasonId: input.arcPlan.season_id,
      participantIds: participants.map((p) => p.character_id),
      specVersion: input.spec.version,
    },
    { capTokens: ctx.policy.context.active_constraints_cap_tokens },
  );

  // 4. Locations
  const locationsSet = new Set<string>();
  if (Array.isArray(r.locations)) {
    for (const loc of r.locations) {
      const lid = resolveEntityId(typeof loc === 'object' && loc !== null ? (loc.location_id || loc.id) : loc, 'location');
      if (lid && knownEntityIds.has(lid)) locationsSet.add(lid);
    }
  }
  if (Array.isArray(r.scenes)) {
    for (const sc of r.scenes) {
      const lid = resolveEntityId(sc.location_id || sc.location || sc.setting, 'location');
      if (lid && knownEntityIds.has(lid)) locationsSet.add(lid);
    }
  }
  if (locationsSet.size === 0 && defaultLocationId && knownEntityIds.has(defaultLocationId)) {
    locationsSet.add(defaultLocationId);
  }
  const locations = Array.from(locationsSet);

  // 5. Purpose
  const purpose = typeof r.purpose === 'string' && r.purpose.trim().length > 0
    ? r.purpose.trim()
    : (typeof r.chapter_title === 'string'
        ? `${r.chapter_title}: ${r.timeline_position || 'Chapter ' + input.chapterNo}`
        : (typeof r.timeline_position === 'string' ? r.timeline_position : `Chapter ${input.chapterNo} progression`));

  // 6. Must Happen
  const validMustHappenKinds = new Set([
    'event', 'revelation', 'decision', 'progression', 'relationship', 'comedic_beat', 'required_scene',
  ]);
  const validVerifiable = new Set(['extraction', 'judge', 'lexical_marker', 'human']);
  let must_happen: ChapterContract['must_happen'] = [];
  if (Array.isArray(r.must_happen)) {
    must_happen = r.must_happen.map((item: any, idx: number) => {
      if (typeof item === 'string') {
        return {
          id: `MH-${input.chapterNo}-${idx + 1}`,
          kind: 'event' as const,
          description: item,
          verifiable_by: 'judge' as const,
        };
      }
      return {
        id: item?.id ? String(item.id) : `MH-${input.chapterNo}-${idx + 1}`,
        kind: validMustHappenKinds.has(item?.kind) ? item.kind : ('event' as const),
        description: item?.description ? String(item.description) : String(item),
        verifiable_by: validVerifiable.has(item?.verifiable_by) ? item.verifiable_by : ('judge' as const),
      };
    });
  }
  if (must_happen.length === 0) {
    must_happen = [
      {
        id: `MH-${input.chapterNo}-1`,
        kind: 'event',
        description: purpose,
        verifiable_by: 'judge',
      },
    ];
  }

  // 7. Must Not Happen
  const validSources = new Set(['spec', 'arc', 'local', 'content_restriction']);
  let must_not_happen: ChapterContract['must_not_happen'] = [];
  if (Array.isArray(r.must_not_happen)) {
    must_not_happen = r.must_not_happen.map((item: any, idx: number) => {
      if (typeof item === 'string') {
        return {
          id: `MN-${input.chapterNo}-${idx + 1}`,
          description: item,
          source: 'spec' as const,
        };
      }
      return {
        id: item?.id ? String(item.id) : `MN-${input.chapterNo}-${idx + 1}`,
        description: item?.description ? String(item.description) : String(item),
        source: validSources.has(item?.source) ? item.source : ('spec' as const),
      };
    });
  }
  if (must_not_happen.length === 0) {
    must_not_happen = [
      {
        id: `MN-${input.chapterNo}-1`,
        description: 'Protagonist must not reveal full future knowledge prematurely.',
        source: 'spec',
      },
    ];
  }

  // 8. Story Time
  const story_time: ChapterContract['story_time'] = {
    start: {
      chapter_no: input.chapterNo,
      ordinal: 0,
      world_date: `D+${input.chapterNo}`,
      precision: 'exact',
    },
    end: {
      chapter_no: input.chapterNo,
      ordinal: 99,
      world_date: `D+${input.chapterNo}`,
      precision: 'exact',
    },
    elapsed_since_previous: typeof r.timeline_position === 'string'
      ? r.timeline_position
      : (typeof r.story_time?.elapsed_since_previous === 'string'
          ? r.story_time.elapsed_since_previous
          : `Day ${input.chapterNo}`),
  };

  // 9. State Deltas
  const state_deltas: ChapterContract['state_deltas'] = [];
  if (r.state_deltas && typeof r.state_deltas === 'object' && !Array.isArray(r.state_deltas)) {
    for (const [k, v] of Object.entries(r.state_deltas)) {
      state_deltas.push({
        entity_id: pov.character_id,
        attribute: k,
        from: null,
        to: typeof v === 'object' ? JSON.stringify(v) : String(v),
        when_in_chapter: 'middle',
        description: `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`,
      });
    }
  } else if (Array.isArray(r.state_deltas)) {
    for (const sd of r.state_deltas) {
      if (sd && typeof sd === 'object') {
        const eid = resolveEntityId(sd.entity_id, 'character') ?? pov.character_id;
        state_deltas.push({
          entity_id: eid,
          attribute: sd.attribute ? String(sd.attribute) : 'state',
          from: sd.from ?? null,
          to: sd.to !== undefined ? (typeof sd.to === 'object' ? JSON.stringify(sd.to) : String(sd.to)) : 'updated',
          when_in_chapter: ['early', 'middle', 'late'].includes(sd.when_in_chapter) ? sd.when_in_chapter : 'middle',
          ...(sd.description ? { description: String(sd.description) } : {}),
        });
      }
    }
  }

  // 10. Relationship Deltas
  const relationship_deltas: ChapterContract['relationship_deltas'] = [];
  const validAxes = new Set(['trust', 'affection', 'respect', 'hostility', 'dependency', 'type']);
  const validDirections = new Set(['up', 'down', 'change']);
  if (Array.isArray(r.relationship_deltas)) {
    for (const rd of r.relationship_deltas) {
      if (!rd || typeof rd !== 'object') continue;
      let fromId = resolveEntityId(rd.from_id || rd.from, 'character');
      let toId = resolveEntityId(rd.to_id || rd.to, 'character');
      if ((!fromId || !toId) && typeof rd.pair === 'string') {
        const parts = rd.pair.split(/[→\->,]/).map((s: string) => s.trim());
        if (parts[0]) fromId = resolveEntityId(parts[0], 'character');
        if (parts[1]) toId = resolveEntityId(parts[1], 'character');
      }
      if (fromId && toId && knownEntityIds.has(fromId) && knownEntityIds.has(toId) && fromId !== toId) {
        relationship_deltas.push({
          from_id: fromId,
          to_id: toId,
          axis: (validAxes.has(rd.axis) ? rd.axis : 'type') as any,
          direction: (validDirections.has(rd.direction) ? rd.direction : 'change') as any,
          magnitude: typeof rd.magnitude === 'number' && rd.magnitude >= 1 && rd.magnitude <= 5 ? rd.magnitude : 1,
          description: rd.description || rd.delta || undefined,
        });
      }
    }
  }

  // 11. Local Satisfaction
  const toPayoffType = (s: string): 'satisfaction' | 'revelation' | 'emotional_step' | 'growth_confirmed' | 'humor_beat' => {
    const l = s.toLowerCase();
    if (l.includes('cider') || l.includes('사이다') || l.includes('satisfaction')) return 'satisfaction';
    if (l.includes('humor') || l.includes('comedy') || l.includes('misunderstanding')) return 'humor_beat';
    if (l.includes('revelation') || l.includes('secret') || l.includes('reveal')) return 'revelation';
    if (l.includes('growth') || l.includes('progression') || l.includes('stat') || l.includes('rank')) return 'growth_confirmed';
    if (l.includes('emotion') || l.includes('romance') || l.includes('vulnerability')) return 'emotional_step';
    return 'satisfaction';
  };

  let local_satisfaction: ChapterContract['local_satisfaction'] = [] as any;
  if (typeof r.local_satisfaction === 'string') {
    local_satisfaction = [
      {
        type: toPayoffType(r.local_satisfaction),
        description: r.local_satisfaction,
      },
    ] as any;
  } else if (Array.isArray(r.local_satisfaction)) {
    local_satisfaction = r.local_satisfaction.map((item: any) => {
      if (typeof item === 'string') {
        return { type: toPayoffType(item), description: item };
      }
      const t = item?.type ? toPayoffType(item.type) : 'satisfaction';
      return { type: t, description: item?.description ? String(item.description) : JSON.stringify(item) };
    }) as any;
  }
  if (local_satisfaction.length === 0) {
    local_satisfaction = [
      {
        type: 'satisfaction',
        description: 'Protagonist intervention succeeds cleanly without raising suspicion.',
      },
    ] as any;
  }

  // 12. Ending State
  let ending_state = 'Chapter ends at peak tension.';
  if (typeof r.ending_state === 'string') {
    ending_state = r.ending_state;
  } else if (r.ending_state && typeof r.ending_state === 'object') {
    ending_state = r.ending_state.description || JSON.stringify(r.ending_state);
  }

  // 13. Hook
  const validEndingTypes = new Set([
    'cliffhanger', 'reveal', 'decision', 'arrival_of_threat', 'emotional_peak', 'quiet_ominous', 'mid_scene_fade', 'summary_reflection',
  ]);
  let hook: ChapterContract['hook'];
  if (r.hook && typeof r.hook === 'object') {
    hook = {
      type: (validEndingTypes.has(r.hook.type) ? r.hook.type : 'cliffhanger') as any,
      description: r.hook.description ? String(r.hook.description) : String(r.hook),
      ...(r.hook.question_raised ? { question_raised: String(r.hook.question_raised) } : {}),
    };
  } else if (r.ending_state && typeof r.ending_state === 'object') {
    hook = {
      type: (validEndingTypes.has(r.ending_state.type) ? r.ending_state.type : 'cliffhanger') as any,
      description: r.ending_state.description ? String(r.ending_state.description) : ending_state,
    };
  } else {
    hook = {
      type: 'cliffhanger',
      description: ending_state,
    };
  }

  // 14. Opening
  const validOpeningTypes = new Set([
    'continue_cliffhanger', 'in_medias_res', 'sharp_dialogue', 'status_update', 'time_skip_with_tension', 'weather_landscape', 'lore_dump', 'waking_up_routine',
  ]);
  let opening: ChapterContract['opening'];
  if (r.opening && typeof r.opening === 'object') {
    opening = {
      type: (validOpeningTypes.has(r.opening.type) ? r.opening.type : 'in_medias_res') as any,
      description: r.opening.description ? String(r.opening.description) : (r.opening.hook ? String(r.opening.hook) : 'Opens in medias res.'),
    };
  } else if (typeof r.opening === 'string') {
    opening = {
      type: 'in_medias_res',
      description: r.opening,
    };
  } else {
    opening = {
      type: 'in_medias_res',
      description: 'Opens in medias res with immediate tension.',
    };
  }

  // 15. Acceptance Criteria
  let acceptance_criteria: ChapterContract['acceptance_criteria'] = [] as any;
  if (Array.isArray(r.acceptance_criteria)) {
    acceptance_criteria = r.acceptance_criteria.map((item: any, idx: number) => {
      if (typeof item === 'string') {
        return {
          id: `AC-${input.chapterNo}-${idx + 1}`,
          kind: 'judge' as const,
          description: item,
        };
      }
      return {
        id: item?.id ? String(item.id) : `AC-${input.chapterNo}-${idx + 1}`,
        kind: ['deterministic', 'judge', 'human'].includes(item?.kind) ? item.kind : ('judge' as const),
        description: item?.description ? String(item.description) : JSON.stringify(item),
      };
    }) as any;
  }
  if (acceptance_criteria.length === 0) {
    acceptance_criteria = [
      {
        id: `AC-${input.chapterNo}-1`,
        kind: 'judge',
        description: 'Chapter opens on immediate tension and protagonist acts proactively.',
      },
    ] as any;
  }

  // 16. Scene Count
  let scene_count = 3;
  if (Array.isArray(r.scenes) && r.scenes.length >= 1) {
    scene_count = Math.max(1, Math.min(8, r.scenes.length));
  } else if (typeof r.scene_count === 'number' && r.scene_count >= 1 && r.scene_count <= 8) {
    scene_count = r.scene_count;
  }

  // 17. Conflict & Emotional Movement
  const conflict: ChapterContract['conflict'] = {
    type: ['external', 'internal', 'interpersonal', 'social'].includes(r.conflict?.type) ? r.conflict.type : 'interpersonal',
    description: r.conflict?.description ? String(r.conflict.description) : 'Navigating immediate crisis while concealing true capabilities.',
    ...(r.conflict?.reversal ? { reversal: String(r.conflict.reversal) } : {}),
  };

  const emotional_movement: ChapterContract['emotional_movement'] = {
    start: r.emotional_movement?.start ? String(r.emotional_movement.start) : 'Disorientation and tension',
    ...(r.emotional_movement?.peak ? { peak: String(r.emotional_movement.peak) } : {}),
    end: r.emotional_movement?.end ? String(r.emotional_movement.end) : 'Unresolved cliffhanger with lingering dread',
  };

  // Build candidate
  const candidate: ChapterContract = {
    id: input.contractId,
    project_id: ctx.projectId,
    chapter_number: input.chapterNo,
    version: 1,
    arc_id: input.arcPlan.id,
    season_id: input.arcPlan.season_id,
    timeline_id: input.mainTimelineId,
    status: 'draft',
    pinned: {
      spec_version: input.spec.version,
      bible_version: 1,
      narrative_identity_version_id: ctx.pins.narrativeIdentityVersionId,
      canon_version: project.canon_version,
      template_version: 'pack.chapter_planner@1.0.0',
    },
    purpose,
    must_happen,
    must_not_happen,
    pov,
    participants,
    locations,
    story_time,
    knowledge_deltas: [],
    state_deltas,
    relationship_deltas,
    setups: [],
    payoffs: [],
    emotional_movement,
    conflict,
    local_satisfaction,
    ending_state,
    hook,
    opening,
    scene_count,
    dialogue_density_target: typeof r.dialogue_density_target === 'number' && r.dialogue_density_target >= 0 && r.dialogue_density_target <= 1 ? r.dialogue_density_target : 0.45,
    ...(typeof r.monologue_density_target === 'number' ? { monologue_density_target: r.monologue_density_target } : {}),
    continuity_risks: [],
    continuity_anchors: [],
    knowledge_guards: [],
    acceptance_criteria,
    length_target: {
      unit: 'words',
      value: input.lengthTargetWords || (typeof r.word_count_target === 'number' ? r.word_count_target : 2500),
      tolerance_ratio: 0.12,
    },
    narrative_identity_version_id: ctx.pins.narrativeIdentityVersionId,
    active_constraints_ref: {
      id: acs.id,
      content_hash: acs.contentHash,
      token_count: acs.tokenCount,
    },
  };

  return { candidate, acs };
}

export function validateContract(
  c: ChapterContract,
  input: Pick<ContractInput, 'chapterNo' | 'spec' | 'mainTimelineId'>,
  knownPropositionIds: ReadonlySet<string>,
  knownEntityIds: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const v = validatorFor<ChapterContract>('chapter-contract.schema.json')(c);
  if (!v.ok) {
    for (const e of v.errors) issues.push(`schema ${e.path}: ${e.message}`);
    return issues;
  }
  if (c.chapter_number !== input.chapterNo) issues.push('chapter_number mismatch');
  if (c.timeline_id !== input.mainTimelineId)
    issues.push('contract timeline is not the main timeline');
  if (c.pinned.spec_version !== input.spec.version) issues.push('pinned spec_version mismatch');
  const onPage = c.participants.filter((p) => p.on_page);
  if (onPage.length === 0) issues.push('no on-page participant');
  if (!c.participants.some((p) => p.character_id === c.pov.character_id))
    issues.push('POV character is not a participant');
  for (const p of c.participants)
    if (!knownEntityIds.has(p.character_id)) issues.push(`unknown participant ${p.character_id}`);
  for (const l of c.locations) if (!knownEntityIds.has(l)) issues.push(`unknown location ${l}`);
  for (const g of c.knowledge_guards)
    for (const pid of g.must_not_know_proposition_ids)
      if (!knownPropositionIds.has(pid)) issues.push(`guard cites unknown proposition ${pid}`);
  for (const d of c.knowledge_deltas)
    if (d.proposition_id && !knownPropositionIds.has(d.proposition_id))
      issues.push(`knowledge delta cites unknown proposition ${d.proposition_id}`);
  if (c.scene_count < 1) issues.push('scene_count must be ≥ 1');
  if (c.story_time.start.chapter_no !== input.chapterNo)
    issues.push('story_time.start is not in this chapter');
  // Forbidden developments scoped to a later chapter must not be planned now.
  const forbidden = input.spec.items.filter(
    (i) => i.kind === 'hard' && i.category === 'forbidden_development',
  );
  for (const f of forbidden) {
    const notBefore = /before ch\.?\s*(\d+)/i.exec(f.text);
    if (notBefore?.[1] && input.chapterNo < Number(notBefore[1])) {
      const subject = f.text.split(/before ch/i)[0]?.toLowerCase() ?? '';
      const key = subject.includes('regression')
        ? 'regression'
        : subject.includes('confession')
          ? 'confession'
          : subject.includes('watcher')
            ? "watcher's identity"
            : undefined;
      if (key && c.must_happen.some((m) => m.description.toLowerCase().includes(`reveal ${key}`)))
        issues.push(`must_happen plans a forbidden development (${f.id}) before its chapter`);
    }
  }
  return issues;
}

export function compilePlannerBlock(ctx: WorkflowContext) {
  return compileFor(ctx, 'planner_compact');
}

export function compileFor(
  ctx: WorkflowContext,
  role:
    | 'planner_compact'
    | 'editor_full'
    | 'judge_rubric_prose'
    | 'judge_rubric_structure'
    | 'judge_rubric_genre'
    | 'summarizer_min'
    | 'writer_full',
  budget = 6000,
) {
  const b = compileBlock(ctx.identity, { role, budgetTokens: budget });
  return {
    text: b.text,
    hash: b.hash,
    identityTail: b.identityTail,
    outputLanguageContractHash: b.outputLanguageContractHash,
    traditionContractHash: b.traditionContractHash,
    roleVariant: role,
  };
}

function renderBibleState(b: StoryBible, bindings?: Readonly<Record<string, string>>): string {
  return [
    renderBibleDesign(b),
    ...b.entities.map(
      (e) =>
        `- [${e.id}] ${e.display_name} (${e.type})${e.description ? `: ${e.description}` : ''}`,
    ),
    ...b.propositions.map((p) => {
      const id = bindings?.[`proposition.${p.local_id}`];
      return `- proposition ${id ? `[${id}] ` : ''}${p.local_id}: ${p.statement} [${p.truth}${p.secret ? ', secret' : ''}]`;
    }),
  ].join('\n');
}

export function renderBibleDesign(b: StoryBible): string {
  return b.design
    ? `[PLANNED — COMPLETE STORY DESIGN, NOT REALIZED EVENTS]\n${JSON.stringify(b.design)}\nUse registry IDs below. Accepted canon takes precedence over intended developments; secrets are not public knowledge.`
    : '';
}

function renderKnowledge(b: StoryBible): string {
  const byId = new Map(b.entities.map((e) => [e.id, e.display_name]));
  const lines = b.propositions
    .filter((p) => p.secret)
    .map((p) => {
      const s = p.secret as { owner_ids?: string[]; allowed_knower_ids?: string[] };
      const knowers = (s.allowed_knower_ids ?? []).map((id) => byId.get(id) ?? id);
      return `- ${p.local_id} (${p.statement}) is known only by: ${knowers.join(', ') || 'nobody yet'}. Everyone else must NOT know it.`;
    });
  return lines.join('\n') || '(no secrets recorded in the bible)';
}

/** Accepted facts so far, rendered compactly for the planner; empty before chapter 1. */
async function renderCanonFacts(ctx: WorkflowContext, chapterNo: number): Promise<string> {
  if (chapterNo === 1) return '';
  const r = await ctx.pool.query<{
    display_name: string;
    attribute: string;
    value_text: string | null;
  }>(
    `SELECT e.display_name, f.attribute, f.value_text FROM facts f JOIN entities e ON e.id = f.entity_id
      WHERE f.project_id = $1 AND f.retracted_at_version IS NULL AND f.valid_to IS NULL
      ORDER BY f.id DESC LIMIT 120`,
    [ctx.projectId],
  );
  if (r.rows.length === 0) return '';
  return `\n\nAccepted facts (what has happened):\n${r.rows
    .map((f) => `- ${f.display_name}: ${f.attribute} = ${f.value_text ?? ''}`)
    .join('\n')}`;
}

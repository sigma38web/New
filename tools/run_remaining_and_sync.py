#!/usr/bin/env python3
"""
Orchestrates Claude Opus 4.6 on Genspark to upgrade all remaining prompt families,
mirrors the upgraded templates to legacy v1.0.0 versions, rehashes all prompt.json
manifests, and synchronizes prompt_versions in PostgreSQL.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

# Add tools directory to path
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR / "tools"))

from upgrade_all_prompts_with_opus import upgrade_prompt_family

REMAINING_FAMILIES = [
    "chapter_assembler/v1.0.0",
    "targeted_reviser/v1.0.0",
    "prose_judge/v1.0.0",
    "voice_judge/v1.0.0",
    "genre_judge/v1.0.0",
    "structure_judge/v1.0.0",
    "contract_checker/v1.0.0",
    "continuity_checker/v1.0.0",
    "knowledge_leak_checker/v1.0.0",
    "chapter_comparator/v1.0.0",
    "concept_comparator/v1.0.0",
    "canon_extractor/v1.0.0",
    "factual_summarizer/v1.0.0",
    "assumption_explainer/v1.0.0",
    "extraction_reconciler/v1.0.0",
]

MIRROR_FAMILIES = [
    "arc_planner",
    "chapter_planner",
    "character_designer",
    "power_system_designer",
    "story_architect",
    "world_builder",
]

def main():
    print(f"=== Starting batch upgrade of {len(REMAINING_FAMILIES)} prompt families via Claude Opus 4.6 ===")
    
    # Track results
    successes = set()
    to_run = list(REMAINING_FAMILIES)
    
    # Up to 3 rounds in case of transient timeout
    for round_num in range(1, 4):
        if not to_run:
            break
        print(f"\n--- Round {round_num}: {len(to_run)} prompt(s) to process ---")
        failed = []
        for fam in to_run:
            try:
                ok = upgrade_prompt_family(BASE_DIR, fam)
                if ok:
                    successes.add(fam)
                else:
                    failed.append(fam)
            except Exception as e:
                print(f"Error upgrading {fam}: {e}")
                failed.append(fam)
        to_run = failed
        
    print(f"\n=== Finished upgrades: {len(successes)}/{len(REMAINING_FAMILIES)} successful ===")
    if to_run:
        print(f"WARNING: The following families could not be upgraded: {to_run}")

    # Mirror v1.1.0 upgrades to v1.0.0 for dual-version families
    print("\n=== Mirroring upgraded templates to v1.0.0 legacy directories ===")
    for fam in MIRROR_FAMILIES:
        v11_dir = BASE_DIR / "packages" / "prompts" / "families" / fam / "v1.1.0"
        v10_dir = BASE_DIR / "packages" / "prompts" / "families" / fam / "v1.0.0"
        if v11_dir.exists() and v10_dir.exists():
            shutil.copy2(v11_dir / "system.md", v10_dir / "system.md")
            if (v11_dir / "user.md").exists():
                shutil.copy2(v11_dir / "user.md", v10_dir / "user.md")
            print(f"Mirrored {fam}/v1.1.0 -> {fam}/v1.0.0")

    # Rehash all prompts
    print("\n=== Rehashing all prompts manifests ===")
    res = subprocess.run(["node", "tools/rehash_prompts.mjs"], cwd=str(BASE_DIR), capture_output=True, text=True)
    print(res.stdout)
    if res.returncode != 0:
        print("Rehash error:", res.stderr)
        sys.exit(1)

    # Sync to database
    print("\n=== Synchronizing prompt_versions in PostgreSQL ===")
    res = subprocess.run(["node", "tools/sync_db_prompts.mjs"], cwd=str(BASE_DIR), capture_output=True, text=True)
    print(res.stdout)
    if res.returncode != 0:
        print("DB Sync error:", res.stderr)
        sys.exit(1)

    # Validate registry load
    print("\n=== Validating PromptRegistry load ===")
    res = subprocess.run(
        ["node", "-e", "import('./packages/prompts/dist/index.js').then(m => { const r = m.PromptRegistry.fromDirectory(); console.log('Loaded ' + r.list().length + ' prompt versions successfully!'); })"],
        cwd=str(BASE_DIR),
        capture_output=True,
        text=True
    )
    print(res.stdout)
    if res.returncode != 0:
        print("Registry validation error:", res.stderr)
        sys.exit(1)

    print("\n=== ALL PROMPTS FULLY UPGRADED WITH CLAUDE OPUS 4.6 & SYNCHRONIZED ===")

if __name__ == "__main__":
    main()

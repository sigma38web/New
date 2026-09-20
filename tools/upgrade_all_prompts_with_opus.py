#!/usr/bin/env python3
"""
Orchestrates Claude Opus 4.6 on Genspark to rewrite and upgrade all Yeonjae Studio prompt families
with authentic Korean webnovel conventions (사이다, 고구마, 절단신공, 티키타카, 착각계, reaction economy,
dopaminergic progression, mobile white-space prose).
"""

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

BRIDGE_URL = "http://127.0.0.1:8091/v1/complete"
MODEL_ID = "claude-opus-4-6"

def call_opus(system_prompt: str, user_prompt: str, max_tokens: int = 4000) -> str:
    payload = {
        "modelId": MODEL_ID,
        "system": system_prompt,
        "user": user_prompt,
        "params": {"temperature": 0.25, "max_tokens": max_tokens},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BRIDGE_URL, data=data, headers={"Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                return res.get("text", "")
        except Exception as exc:
            print(f"  [Attempt {attempt+1} failed]: {exc}")
            time.sleep(3)
    raise RuntimeError(f"Failed to get response from {MODEL_ID}")

def extract_code_block(text: str, header: str) -> str:
    pattern = rf"{header}\s*```(?:markdown)?\s*\n(.*?)\n```"
    match = re.search(pattern, text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return ""

SYSTEM_DIRECTOR = """You are the master editorial director and lead prompt architect for premium Korean webnovels (Munpia, Naver Series, KakaoPage, Novelpia).
You have full creative and architectural authority to rewrite studio prompts to guarantee authentic Korean serialized webnovel quality.

Mandatory Core Directives:
1. KOREAN WEBNOVEL TRADITION & GENRE MECHANICS:
   - Cider (사이다) vs Sweet Potato (고구마): Explicitly calibrate frustration and catharsis. The protagonist must possess proactive agency; tension must never lead to helpless passivity.
   - Narrative Hook & 절단신공 (Cliffhanger Discipline): Openings must immediately establish conflict/stakes; scene and chapter exits must cut on maximum curiosity or tension.
   - Dialogue & Social Registers (티키타카): Fast-paced, responsive dialogue banter. Dynamic shifts between formal honorifics (존댓말) and informal speech (반말) translated into natural English registers.
   - Reaction Economy (반응 경제 / 착각계): Observer perspectives, bystander disbelief, and public reclassification of the protagonist or entourage.
   - Dopaminergic Progression Cadence: Regular, tangible milestones (awakenings, tier breakthroughs, stat updates, social recognition) every 3-5 chapters.
   - Natural English Manuscript Prose: Idiomatic, engaging English without awkward translationese, calqued Asian honorific suffixes (hyung/oppa/sunbae), or clunky machine-translation idioms ("courting death"). Short 1-4 sentence paragraphs for mobile pacing.

2. STRICT VARIABLE & SCHEMA INTEGRITY:
   - You MUST preserve all required template variables (e.g. {{variable_name}}, {{narrative_identity_block}}).
   - You MUST preserve all required JSON output shape constraints. Downstream systems parse the exact JSON schemas.
   - Do NOT add markdown wrappers or prose outside the required output format.

Format your reply:
### Critique
<Specific evaluation of missing webnovel nuances>

### Upgraded system.md
```markdown
<complete upgraded system.md text>
```

### Upgraded user.md
```markdown
<complete upgraded user.md text, or leave empty if user.md does not need change>
```
"""

def upgrade_prompt_family(base_dir: Path, rel_path: str):
    fam_dir = base_dir / "packages" / "prompts" / "families" / rel_path
    sys_file = fam_dir / "system.md"
    user_file = fam_dir / "user.md"
    prompt_json = fam_dir / "prompt.json"
    
    if not sys_file.exists():
        print(f"Skipping {rel_path}: system.md does not exist")
        return False
        
    current_system = sys_file.read_text("utf-8")
    current_user = user_file.read_text("utf-8") if user_file.exists() else ""
    meta = json.loads(prompt_json.read_text("utf-8")) if prompt_json.exists() else {}
    
    print(f"\n=======================================================")
    print(f"Sending prompt to Claude Opus 4.6 on Genspark: {rel_path}")
    print(f"Role: {meta.get('role', 'N/A')} | Family: {meta.get('family', rel_path)}")
    print(f"=======================================================")
    
    user_request = (
        f"Rewrite and upgrade the following prompt family to authentic Korean webnovel standards:\n"
        f"Family: {rel_path}\n"
        f"Role: {meta.get('role', '')}\n"
        f"Purpose: {meta.get('purpose', '')}\n"
        f"Params: {json.dumps(meta.get('params', {}))}\n\n"
        f"--- CURRENT system.md ---\n{current_system}\n\n"
        f"--- CURRENT user.md ---\n{current_user}\n"
    )
    
    start_time = time.time()
    response = call_opus(SYSTEM_DIRECTOR, user_request, max_tokens=3500)
    elapsed = time.time() - start_time
    print(f"Received upgrade from Claude Opus 4.6 in {elapsed:.1f}s")
    
    # Save full audit response
    audit_dir = base_dir / "tools" / "prompt_audits" / rel_path
    audit_dir.mkdir(parents=True, exist_ok=True)
    (audit_dir / "opus_upgrade_raw.md").write_text(response, "utf-8")
    
    upgraded_system = extract_code_block(response, "### Upgraded system.md")
    upgraded_user = extract_code_block(response, "### Upgraded user.md")
    
    if upgraded_system:
        # Check that essential template variables are preserved
        orig_vars = re.findall(r"\{\{([a-zA-Z0-9_]+)\}\}", current_system)
        for var in orig_vars:
            if f"{{{{{var}}}}}" not in upgraded_system:
                print(f"  [Warning]: Restoring missing template variable {{{{{var}}}}} to system.md")
                upgraded_system += f"\n\n{{{{{var}}}}}"
                
        sys_file.write_text(upgraded_system.strip() + "\n", "utf-8")
        print(f"Successfully upgraded system.md for {rel_path} ({len(upgraded_system)} chars)")
    else:
        print(f"  [Error]: Could not extract upgraded system.md for {rel_path}")
        return False
        
    if upgraded_user and user_file.exists():
        orig_user_vars = re.findall(r"\{\{([a-zA-Z0-9_]+)\}\}", current_user)
        for var in orig_user_vars:
            if f"{{{{{var}}}}}" not in upgraded_user:
                upgraded_user += f"\n\n{{{{{var}}}}}"
        user_file.write_text(upgraded_user.strip() + "\n", "utf-8")
        print(f"Successfully upgraded user.md for {rel_path} ({len(upgraded_user)} chars)")
        
    return True

def main():
    base_dir = Path(__file__).resolve().parent.parent
    targets = sys.argv[1:]
    if not targets:
        print("Usage: python3 tools/upgrade_all_prompts_with_opus.py <family1/vX.Y.Z> ...")
        sys.exit(1)
        
    successes = 0
    for target in targets:
        try:
            if upgrade_prompt_family(base_dir, target):
                successes += 1
        except Exception as exc:
            print(f"Failed to upgrade {target}: {exc}")
            
    print(f"\nCompleted {successes}/{len(targets)} prompt upgrades via Claude Opus 4.6.")

if __name__ == "__main__":
    main()

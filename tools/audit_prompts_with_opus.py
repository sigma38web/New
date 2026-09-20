#!/usr/bin/env python3
"""
Audit and refine Yeonjae Studio prompt families using Claude Opus 4.6 on Genspark.
Evaluates Korean webnovel authenticity, secondary genre preservation (e.g. slow-burn romance),
cider/pacing rhythm, dialogue banter, and schema compliance.
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

BRIDGE_URL = "http://127.0.0.1:8091/v1/complete"
MODEL_ID = "claude-opus-4-6"

CORE_PROMPT_FAMILIES = [
    "requirement_interpreter/v1.0.0",
    "concept_generator/v1.0.0",
    "story_architect/v1.1.0",
    "character_designer/v1.1.0",
    "power_system_designer/v1.1.0",
    "world_builder/v1.1.0",
    "arc_planner/v1.1.0",
    "chapter_planner/v1.1.0",
    "scene_planner/v1.0.0",
    "scene_writer/v1.0.0",
    "targeted_reviser/v1.0.0",
    "genre_judge/v1.0.0",
    "prose_judge/v1.0.0",
    "voice_judge/v1.0.0",
]

def call_opus(system_prompt: str, user_prompt: str, max_tokens: int = 4000) -> str:
    payload = {
        "modelId": MODEL_ID,
        "system": system_prompt,
        "user": user_prompt,
        "params": {"temperature": 0.2, "max_tokens": max_tokens},
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
            time.sleep(2)
    raise RuntimeError("Failed to get response from Claude Opus 4.6")

def audit_family(base_dir: Path, rel_path: str):
    family_dir = base_dir / "packages" / "prompts" / "families" / rel_path
    sys_file = family_dir / "system.md"
    user_file = family_dir / "user.md"
    prompt_json = family_dir / "prompt.json"
    
    if not sys_file.exists():
        print(f"Skipping {rel_path}: system.md not found")
        return
        
    current_system = sys_file.read_text("utf-8")
    current_user = user_file.read_text("utf-8") if user_file.exists() else ""
    meta = json.loads(prompt_json.read_text("utf-8")) if prompt_json.exists() else {}
    
    print(f"\n=======================================================")
    print(f"Auditing with Claude Opus 4.6: {rel_path} ({meta.get('role', 'prompt')})")
    print(f"=======================================================")
    
    system_consultant = (
        "You are an elite editorial director for premium serialized Korean webnovels (Munpia, Naver Series, KakaoPage, Novelpia). "
        "You are auditing the prompt engineering of an automated AI studio producing English serialized manuscripts in the authentic Korean webnovel tradition.\n\n"
        "Your mission is to upgrade the provided system.md and user.md to ensure:\n"
        "1. STRICT GENRE INTEGRITY: Secondary genres (such as slow-burn romance, academy, misunderstanding, or revenge) and explicit user constraints MUST NOT be drowned out by the primary genre. They must be treated as mandatory structural pillars.\n"
        "2. KOREAN WEBNOVEL DNA: Enforce the core rhythms of serialized webnovels:\n"
        "   - Immediate narrative hook and tension within the opening beats (no leisurely exposition).\n"
        "   - 'Cider' (사이다) payoff and catharsis: proactive protagonist agency, crushing setbacks followed by sharp comeuppance, avoiding endless passive frustration (고구마).\n"
        "   - Dopaminergic progression (clear power/status/social reclassification, distinct numerical or tier leaps, diegetic notification windows where appropriate).\n"
        "   - Rhythmic dialogue banter (티키타카) and social tension (shifts between formal honorifics and subtle familiarity).\n"
        "   - High-tension cliffhanger endings for chapters and arcs (절단신공).\n"
        "   - Third-party observers & reaction economy (witnesses reacting in disbelief or re-evaluating the protagonist).\n"
        "3. OUTPUT FORMAT PRESERVATION: You must strictly preserve the required input variables (e.g. {{variable_name}}) and the output requirements (valid JSON matching schema, English prose, no markdown wrappers outside JSON).\n"
        "4. Return clean, directly usable, production-ready markdown for system.md and user.md."
    )
    
    user_request = (
        f"Audit and improve the following prompt family:\n"
        f"Family: {rel_path}\n"
        f"Purpose: {meta.get('purpose', '')}\n\n"
        f"--- CURRENT system.md ---\n{current_system}\n\n"
        f"--- CURRENT user.md ---\n{current_user}\n\n"
        f"Please provide:\n"
        f"1. A concise critique of what Korean webnovel nuances and secondary-genre protections are missing.\n"
        f"2. Upgraded production-grade text for system.md.\n"
        f"3. Upgraded production-grade text for user.md (if user.md needs enhancements).\n"
        f"Format your response with clear markdown headers:\n"
        f"### Critique\n<critique>\n\n"
        f"### Upgraded system.md\n```markdown\n<upgraded system text>\n```\n\n"
        f"### Upgraded user.md\n```markdown\n<upgraded user text>\n```"
    )
    
    response = call_opus(system_consultant, user_request, max_tokens=3500)
    
    out_dir = base_dir / "tools" / "prompt_audits" / rel_path
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "audit_result.md").write_text(response, "utf-8")
    print(f"Saved audit result to {out_dir / 'audit_result.md'}")

def main():
    base_dir = Path(__file__).resolve().parent.parent
    families = sys.argv[1:] if len(sys.argv) > 1 else CORE_PROMPT_FAMILIES
    for fam in families:
        try:
            audit_family(base_dir, fam)
        except Exception as exc:
            print(f"Error auditing {fam}: {exc}")

if __name__ == "__main__":
    main()

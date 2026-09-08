"""Bounded explanation review experiment via an installed, authenticated Codex CLI.

No model training, outbound message delivery, or global instruction edits.
Every call runs with tools disabled and saves its exact input/output.

Ported into skills/b3os-how-to-explain on 2026-09-08:
  - instructions come from this skill's references/, not an experiment folder
  - run output goes to --output-root, never inside the installed skill
  - the codex executable is looked up on PATH instead of a hard-coded path
  - model and reasoning effort are settings, not literals
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

SKILL_ROOT = Path(__file__).resolve().parents[1]
REFERENCES = SKILL_ROOT / 'references'

# Settings. Override per machine without editing the file.
MODEL = os.environ.get('B3OS_EXPLAIN_MODEL', 'gpt-6-astra')
REASONING_EFFORT = os.environ.get('B3OS_EXPLAIN_EFFORT', 'medium')


def codex_bin():
    """Path to the codex executable, or a clear failure before any model call."""
    found = os.environ.get('B3OS_CODEX_BIN') or shutil.which('codex')
    if not found:
        raise RuntimeError(
            'codex executable not found. Install and authenticate Codex CLI, '
            'or set B3OS_CODEX_BIN. Without it this tool cannot run; apply the '
            'rules in SKILL.md and references/auditor.md by hand instead.')
    return found


def instructions_for(mode):
    return (REFERENCES / ('auditor.md' if mode == 'audit' else 'rewriter.md')).read_text()


def output_schema(output_type):
    def obj(props):
        return {'type':'object','properties':props,'required':list(props),'additionalProperties':False}
    string = {'type':'string'}
    if output_type == 'audit':
        issue = obj({k:string for k in ['kind','quote','reason','fix']})
        item = obj({'id':string,'verdict':{'type':'string','enum':['pass','revise']},
                    'source_sufficient':{'type':'boolean'},'essential_answer':string,
                    'issues':{'type':'array','items':issue}})
        return obj({'reviews':{'type':'array','items':item}})
    return obj({'answers':{'type':'array','items':obj({'id':string,'text':string})}})


def run_model(instructions, prompt, folder, output_type):
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'instructions.md').write_text(instructions)
    (folder / 'prompt.json').write_text(prompt)
    (folder / 'schema.json').write_text(json.dumps(output_schema(output_type)))
    cmd = [codex_bin(), 'exec', '--ignore-user-config', '--ephemeral',
           '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never',
           '--json', '--model', MODEL, '--output-schema', str(folder/'schema.json'),
           '-c', f'model_reasoning_effort="{REASONING_EFFORT}"',
           '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
           '-c', 'features.shell_tool=false', '-c',
           f'model_instructions_file={json.dumps(str(folder / "instructions.md"))}',
           '-C', str(folder), '-']
    start = time.monotonic()
    process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = process.communicate(prompt, timeout=300)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
    (folder / 'stdout.jsonl').write_text(stdout)
    (folder / 'stderr.log').write_text(stderr)
    events = []
    for line in stdout.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    text = '\n\n'.join(e.get('item', {}).get('text', '') for e in events
                         if e.get('type') == 'item.completed'
                         and e.get('item', {}).get('type') == 'agent_message')
    meta = {'model_requested': MODEL, 'reasoning_effort': REASONING_EFFORT,
            'elapsed_seconds': round(time.monotonic() - start, 1),
            'exit_code': process.returncode, 'timeout': timed_out,
            'usage': next((e.get('usage') for e in reversed(events)
                           if e.get('type') == 'turn.completed'), None),
            'tool_event_types': [e.get('item', {}).get('type') for e in events
                if e.get('type') == 'item.completed'
                and e.get('item', {}).get('type') not in ['agent_message', 'reasoning']]}
    (folder / 'response.md').write_text(text)
    (folder / 'metadata.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    if process.returncode or not text or meta['tool_event_types']:
        raise RuntimeError(f'No usable tool-free response; inspect {folder}')
    # A single enclosing JSON fence is accepted; prose or multiple JSON objects are not.
    if text.startswith('```json\n') and text.rstrip().endswith('```'):
        text = text[len('```json\n'):].rstrip()[:-3].rstrip()
    result = json.loads(text)
    (folder / 'response.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def validate(result, cases, mode):
    key = 'reviews' if mode == 'audit' else 'answers'
    items = result[key]
    ids = [c['id'] for c in cases]
    if len(items) != len(ids) or {i['id'] for i in items} != set(ids):
        raise ValueError('Missing or duplicate response IDs')
    for item in items:
        if mode == 'audit':
            if item['verdict'] not in ['pass', 'revise']:
                raise ValueError('Invalid verdict')
            if not isinstance(item['source_sufficient'], bool):
                raise ValueError('source_sufficient must be boolean')
            if not isinstance(item['essential_answer'], str):
                raise ValueError('Missing essential_answer')
            if not isinstance(item['issues'], list):
                raise ValueError('issues must be an array')
            if (item['verdict'] == 'pass') != (len(item['issues']) == 0):
                raise ValueError('Verdict and issues disagree')
            for issue in item['issues']:
                if not all(isinstance(issue.get(k), str) for k in ['kind','quote','reason','fix']):
                    raise ValueError('Incomplete issue')
                source = next(c for c in cases if c['id'] == item['id'])
                if issue['quote'] and issue['quote'] not in source['draft']:
                    raise ValueError('Issue quotation is not present in draft')
        elif not isinstance(item['text'], str) or not item['text'].strip():
            raise ValueError('Empty revised answer')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['audit','repair'])
    p.add_argument('--cases', required=True, type=Path)
    p.add_argument('--ids', nargs='+', required=True)
    p.add_argument('--run', required=True)
    p.add_argument('--output-root', type=Path, required=True,
                   help='Writable directory for run output. Never the installed skill folder.')
    p.add_argument('--reviews', type=Path)
    p.add_argument('--drafts', type=Path, help='Use answers from a prior repair for re-review')
    p.add_argument('--fresh', action='store_true', help='Rewrite from source and fixes without the old draft')
    args = p.parse_args()
    if Path(args.run).name != args.run or args.run in {'.','..'}:
        p.error('--run must be a directory name')
    pool = json.loads(args.cases.read_text())
    lookup = {c['id']: c for c in pool}
    if len(args.ids) != len(set(args.ids)):
        p.error('Duplicate requested IDs')
    cases = [dict(lookup[c]) for c in args.ids]
    # Only source/question/reader/draft are exposed; expected decisions live in another file.
    cases = [{k: c[k] for k in ['id','question','reader','source','draft']} for c in cases]
    if args.drafts:
        drafts = {a['id']: a['text'] for a in json.loads(args.drafts.read_text())['answers']}
        for c in cases:
            c['draft'] = drafts[c['id']]
    if args.mode == 'repair':
        if not args.reviews:
            p.error('repair requires --reviews')
        reviews = {r['id']: r for r in json.loads(args.reviews.read_text())['reviews']}
        for c in cases:
            c['review'] = reviews[c['id']]
            if args.fresh:
                c.pop('draft')
                c['review'] = {'fixes': [i['fix'] for i in reviews[c['id']]['issues']]}
    elif args.fresh:
        p.error('--fresh applies only to repair')
    instructions = instructions_for(args.mode)
    folder = args.output_root / 'runs' / args.run
    result = run_model(instructions, json.dumps({'cases': cases}, ensure_ascii=False, indent=2), folder, args.mode)
    validate(result, cases, args.mode)
    (folder / 'validated.json').write_text(json.dumps({'valid_structure': True}))
    print(json.dumps({'run': args.run, 'result': result}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()

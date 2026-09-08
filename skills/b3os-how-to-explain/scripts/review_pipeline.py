"""Review -> fresh rewrite -> review, with one rewrite at most and no message delivery."""
import argparse
import json
from pathlib import Path
from review_run import instructions_for, run_model, validate


def pipeline(case, folder, call=run_model):
    required = ['id', 'question', 'reader', 'source', 'draft']
    if not all(isinstance(case.get(k), str) and case[k].strip() for k in required):
        raise ValueError('Input needs non-empty id, question, reader, source, draft')
    case = {k: case[k] for k in required}
    folder.mkdir(parents=True, exist_ok=False)
    (folder/'input.json').write_text(json.dumps(case, ensure_ascii=False, indent=2))
    audit = instructions_for('audit')
    rewrite = instructions_for('repair')

    def invoke(mode, cases, stage):
        result = call(audit if mode == 'audit' else rewrite,
                      json.dumps({'cases': cases}, ensure_ascii=False, indent=2), folder/stage, mode)
        validate(result, cases, mode)
        return result

    first = invoke('audit', [case], '01-audit')['reviews'][0]
    candidate = case['draft']
    final_review = first
    rewritten = False
    if first['verdict'] == 'revise':
        fresh = {k: v for k, v in case.items() if k != 'draft'}
        fresh['review'] = {'fixes': [i['fix'] for i in first['issues']]}
        candidate = invoke('repair', [fresh], '02-rewrite')['answers'][0]['text']
        final_review = invoke('audit', [{**case, 'draft': candidate}], '03-audit')['reviews'][0]
        rewritten = True
    passed = final_review['verdict'] == 'pass'
    (folder/'candidate.md').write_text(candidate)
    if passed:
        (folder/'model-approved.md').write_text(candidate)
    status = {'status': 'model_approved' if passed else 'needs_review',
              'human_approved': False, 'rewritten': rewritten,
              'message_sent': False, 'review': final_review}
    (folder/'status.json').write_text(json.dumps(status, ensure_ascii=False, indent=2))
    return status


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--run', required=True)
    p.add_argument('--output-root', type=Path, required=True,
                   help='Writable directory for run output. Never the installed skill folder.')
    args = p.parse_args()
    if Path(args.run).name != args.run or args.run in {'.', '..'}:
        p.error('--run must be a directory name')
    folder = args.output_root/'pipelines'/args.run
    try:
        status = pipeline(json.loads(args.input.read_text()), folder)
    except Exception as exc:
        # Do not expose a partially checked answer as approved.
        print(json.dumps({'status': 'error', 'error': str(exc), 'run_dir': str(folder)}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps({'status': status['status'], 'run_dir': str(folder)}, ensure_ascii=False))
    if status['status'] == 'needs_review':
        raise SystemExit(2)


if __name__ == '__main__':
    main()

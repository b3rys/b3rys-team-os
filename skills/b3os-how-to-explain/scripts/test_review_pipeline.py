import json
from pathlib import Path
import tempfile
import unittest
from review_pipeline import pipeline
from review_run import validate


CASE = {'id':'sample','question':'왜 갱신하나요?','reader':'구현을 모릅니다.',
        'source':'서버 시작 시 읽고 웹 빌드 시 기록합니다.','draft':'신원이 갈라집니다.'}


def audit(verdict, quote=''):
    return {'reviews':[{'id':'sample','verdict':verdict,'source_sufficient':True,
        'essential_answer':'각 정보의 갱신 시점이 다릅니다.',
        'issues':[] if verdict == 'pass' else [{'kind':'expression','quote':quote,
            'reason':'대상이 없습니다.','fix':'갱신 대상과 시점을 쓰세요.'}]}]}


class ReviewTests(unittest.TestCase):
    def run_stubbed(self, responses):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        calls = []
        def fake(instructions, prompt, folder, output_type):
            calls.append(json.loads(prompt))
            return responses[len(calls)-1]
        folder = Path(tmp.name)/'run'
        return pipeline(CASE, folder, fake), folder, calls

    def test_accepted_draft_is_preserved_without_rewrite(self):
        status, folder, calls = self.run_stubbed([audit('pass')])
        self.assertEqual(len(calls),1)
        self.assertEqual((folder/'model-approved.md').read_text(), CASE['draft'])
        self.assertFalse(status['human_approved'])

    def test_failed_recheck_never_creates_approved_output(self):
        status, folder, calls = self.run_stubbed([audit('revise','신원이 갈라집니다.'),
            {'answers':[{'id':'sample','text':'여전히 추상적입니다.'}]},audit('revise','추상적')])
        self.assertEqual(len(calls),3)
        self.assertNotIn('draft',calls[1]['cases'][0])
        self.assertNotIn('신원이',json.dumps(calls[1],ensure_ascii=False))
        self.assertEqual(status['status'],'needs_review')
        self.assertFalse((folder/'model-approved.md').exists())

    def test_successful_rewrite_needs_second_review(self):
        status, folder, calls = self.run_stubbed([audit('revise'),
            {'answers':[{'id':'sample','text':'서버와 웹의 갱신 시점이 다릅니다.'}]},audit('pass')])
        self.assertEqual(len(calls),3)
        self.assertTrue(status['rewritten'])
        self.assertEqual(status['status'],'model_approved')

    def test_reviewer_cannot_quote_text_absent_from_draft(self):
        with self.assertRaises(ValueError):
            validate(audit('revise','없는 인용'), [CASE], 'audit')

    def test_missing_case_is_rejected(self):
        with self.assertRaises(ValueError):
            validate({'reviews':[]},[CASE],'audit')

    def test_bad_input_stops_before_model_call(self):
        with tempfile.TemporaryDirectory() as d:
            def no_call(*args):
                self.fail('Model must not run with missing source')
            with self.assertRaises(ValueError):
                pipeline({**CASE,'source':''},Path(d)/'run',no_call)


if __name__ == '__main__':
    unittest.main()

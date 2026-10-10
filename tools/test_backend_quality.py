import copy
import json
from pathlib import Path
import tempfile
import unittest
import backend_quality as quality
import lean_workflow as lean


class BackendQualityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.binary = Path(self.tmp.name)/'binary'
        self.binary.write_text('fixture artifact')
        self.evidence = Path(self.tmp.name)/'native-evidence'
        self.evidence.write_text('fixture validation')
        self.manifest = Path(self.tmp.name)/'manifest.json'
        self.data = dict(schema=1, upstream_commit=quality.UPSTREAM, cargo_lock_sha256=quality.LOCK,
                         patch_sha256=lean.digest(quality.PATCH), binary_sha256=lean.digest(self.binary),
                         native_validation=dict(status='passed',evidence=[dict(path=str(self.evidence),
                                                                              sha256=lean.digest(self.evidence))]))
    def bind(self, data=None):
        self.manifest.write_text(json.dumps(self.data if data is None else data))
        return quality.bind(self.binary,self.manifest)

    def test_bound_artifact_requires_quality_capability(self):
        self.assertEqual(self.bind()['mode'],'quality-first')
        quality.require_capability(' --quality-first reject new identities')
        with self.assertRaises(ValueError):
            quality.require_capability('ordinary unpatched backend')

    def test_changed_artifact_cannot_reuse_validation(self):
        self.binary.write_text('replacement')
        with self.assertRaises(ValueError): self.bind()

    def test_different_source_patch_or_lock_cannot_bind(self):
        for key in ('upstream_commit','patch_sha256','cargo_lock_sha256'):
            data=copy.deepcopy(self.data);data[key]='0'*64
            with self.assertRaises(ValueError): self.bind(data)

    def test_missing_changed_or_malformed_native_evidence_rejects(self):
        for validation in ({},dict(status='passed',evidence=[]),[],
                           dict(status='passed',evidence=[dict(path=str(self.evidence),sha256=[])])):
            data=copy.deepcopy(self.data);data['native_validation']=validation
            with self.assertRaises(ValueError):self.bind(data)
        self.evidence.write_text('changed proof')
        with self.assertRaises(ValueError):self.bind()

    def test_legacy_mode_never_claims_quality_or_validation(self):
        self.assertEqual(quality.bind(self.binary,None),dict(mode='legacy-unverified',qualified=False))
        with self.assertRaises((OSError,ValueError)):
            quality.bind(self.binary,'')


if __name__=='__main__': unittest.main()

import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('coding_helper',Path(__file__).with_name('coding_helper.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class CodingBoundary(unittest.TestCase):
 def setUp(self):self.manager=module.Manager('node@sha256:'+'a'*64)
 def test_requires_immutable_image(self):
  with self.assertRaises(ValueError):module.Manager('node:latest')
 def test_isolation_flags_and_no_mount_or_shell(self):
  cmd=self.manager.command('11111111-1111-1111-1111-111111111111','run')
  for flag in ['--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534','--pids-limit=32','--memory=128m','--memory-swap=128m','--log-driver=none']:
   self.assertIn(flag,cmd)
  self.assertNotIn('-v',cmd);self.assertNotIn('--mount',cmd);self.assertNotIn('sh',cmd)
 def test_no_command_or_identifier_injection(self):
  for mode in ['sh','bash','npm','git','curl','run;id']:
   with self.assertRaises(ValueError):self.manager.command('11111111-1111-1111-1111-111111111111',mode)
  with self.assertRaises(ValueError):self.manager.command('../../host','run')
 def test_restart_receipt_is_honest(self):
  self.assertEqual(self.manager.status({'id':'11111111-1111-1111-1111-111111111111'})['status'],'failed')
 def test_source_size_rejected_before_process(self):
  with self.assertRaises(ValueError):self.manager.start({'id':'11111111-1111-1111-1111-111111111111','mode':'run','source':'x'*262145})
if __name__=='__main__':unittest.main()

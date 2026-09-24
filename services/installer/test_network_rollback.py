"""Atomic file/proxy rollback matrix; runtime proof lives in acceptance scripts."""
import importlib.util, os, pathlib, subprocess, tempfile, unittest
from unittest.mock import patch

class NetworkRollback(unittest.TestCase):
    def test_matrix(self):
        for mode in ('lan','domain','proxy'):
            for target in ('lan','domain','proxy'):
             for failure in ('snapshot','env','workspace','up','health','verify'):
                with self.subTest(mode=mode,target=target,failure=failure), tempfile.TemporaryDirectory() as directory:
                    root=pathlib.Path(directory)
                    env=f'JOSI_ACCESS_MODE={mode}\nJOSI_TAG=installed-version\nJOSI_APP_URL=https://old.example.test\n'
                    files={'.env':env,'docker-compose.workspace.yml':'old workspace','docker-compose.noproxy.yml':'old proxy'}
                    for name,data in files.items():(root/name).write_text(data)
                    with patch.dict(os.environ,{'JOSI_INSTALL_ROOT':directory,'JOSI_INSTALLER_HTML':str(pathlib.Path(__file__).with_name('index.html')),'JOSI_EXISTING_INSTALL':'1','JOSI_INSTALL_UID':str(os.getuid()),'JOSI_INSTALL_GID':str(os.getgid())}):
                        spec=importlib.util.spec_from_file_location('controller',pathlib.Path(__file__).with_name('controller.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
                        commands=[];restored=[]
                        def run(args,**kwargs):
                            commands.append(args)
                            if failure=='up' and len(commands)==1:raise RuntimeError('injected')
                            return subprocess.CompletedProcess(args,0,'','')
                        def metadata(action,snapshot=None):
                            if action==failure:raise RuntimeError('injected')
                            if action=='restore':restored.append(snapshot)
                            return {'old':'metadata'}
                        def fail(*args,**kwargs):raise RuntimeError('injected')
                        m.run=run;m.address_metadata=metadata
                        if failure=='env':m.write_env=fail
                        if failure=='workspace':m.write_workspace_override=fail
                        m.verify_public_origin=fail if failure=='health' else lambda *args:None
                        plan={'mode':target,'domain':'new.example.test','appUrl':'https://new.example.test','httpPort':18080,'httpsPort':18443,'webPort':18081,'workspaceEnabled':False}
                        m.install(plan)
                        self.assertEqual(m.PROGRESS['state'],'failed')
                        self.assertTrue(m.PROGRESS['rollbackComplete'])
                        for name,data in files.items():self.assertEqual((root/name).read_text(),data)
                        self.assertNotIn('pull',str(commands))
                        self.assertEqual('--scale' in commands[-1],mode=='proxy')
                        if failure!='snapshot':self.assertEqual(restored,[{'old':'metadata'}])
    def test_failed_recovery_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{'JOSI_INSTALL_ROOT':directory,'JOSI_INSTALLER_HTML':str(pathlib.Path(__file__).with_name('index.html'))}):
            spec=importlib.util.spec_from_file_location('controller',pathlib.Path(__file__).with_name('controller.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
            def fail(*args,**kwargs):raise RuntimeError('credential-must-not-leak')
            m.write_env=fail;m.run=fail;m.install({})
            self.assertFalse(m.PROGRESS['rollbackComplete']);self.assertNotIn('credential-must-not-leak',str(m.PROGRESS))

if __name__=='__main__':unittest.main()

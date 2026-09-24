import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root=join(import.meta.dirname,'../../..');const read=(p:string)=>readFileSync(join(root,p),'utf8');
describe('Test List 6 items 12-16',()=>{
 it('keeps composer focus subtle and pins desktop navigation',()=>{expect(read('apps/web/src/pages/Talk.tsx')).toContain('talk-composer');expect(read('apps/web/src/index.css')).toContain('.talk-composer textarea:focus-visible');expect(read('apps/web/src/components/layout/Shell.tsx')).toContain('overflow-y-auto overscroll-contain');});
 it('suppresses password managers only where autocomplete is explicitly off',()=>{const ui=read('apps/web/src/components/ui/index.tsx');expect(ui).toContain("props.autoComplete === 'off'");expect(ui).toContain("'data-1p-ignore'");expect(read('apps/web/src/pages/Login.tsx')).toContain('current-password');});
 it('ships a narrow maintenance supervisor and no Docker socket in web',()=>{const compose=read('docker-compose.yml');expect(compose).toContain('JOSI_MAINTENANCE_HELPER_SOCKET');expect(compose).not.toMatch(/web:[\s\S]{0,2500}docker\.sock/);const helper=read('services/installer/maintenance_helper.py');expect(helper).toContain("self.path!='/launch'");expect(read('services/installer/controller.py')).toContain('provision_maintenance_helper()');});
});

import { useEffect } from 'react';

/** Warn for browser exits and client-side links while a settings form is dirty. */
export function useUnsavedChanges(dirty:boolean) {
  useEffect(()=>{
    if(!dirty)return;
    const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    const navigate=(event:MouseEvent)=>{
      if(event.defaultPrevented)return;
      const link=(event.target as Element)?.closest('a[href]');
      if(link&&!window.confirm('Discard unsaved changes?')){event.preventDefault();event.stopPropagation();}
    };
    window.addEventListener('beforeunload',unload);
    document.addEventListener('click',navigate,true);
    return ()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('click',navigate,true);};
  },[dirty]);
}

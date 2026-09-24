import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { midnight, addDays, calendarDayLabel, calendarRange, dayKey, eventsOnDay, layoutEvents, moveCalendar, type CalendarView } from '@/lib/calendar';
import { api } from '@/lib/api';
import { plain } from '@/lib/plainLanguage';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';

type View = CalendarView;
interface Source { id:string; connectionId:string; name:string; color:string|null; provider:'google'|'microsoft'; account:string|null; selected:boolean; primary:boolean; writable:boolean; writeDefault:boolean }
interface EventRow { eventId:string; connectionId:string; sourceId:string; sourceName:string; sourceColor:string|null; provider:string; account:string|null; title:string|null; start:string|null; end:string|null; allDay:boolean; location:string|null; organizer:string|null; attendees:string[]; status:string|null }

export function Calendar() {
  const [sources,setSources]=useState<Source[]>([]); const [events,setEvents]=useState<EventRow[]>([]);
  const [anchor,setAnchor]=useState(dayKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)); const [view,setView]=useState<View>('week');
  const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [detail,setDetail]=useState<any>(null);
  const detailRef=useRef<HTMLElement>(null); const lastEventButton=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{if(detail)detailRef.current?.focus();},[detail]);
  const [warnings,setWarnings]=useState<string[]>([]);
  const [zone,setZone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const window=useMemo(()=>calendarRange(anchor,view,zone),[anchor,view,zone]);
  const loadSources=useCallback(async(refresh=false)=>{ const r=await api.get<{sources:Source[];discoveryErrors?:Array<{error:string}>}>(`/calendar/sources${refresh?'?refresh=true':''}`); setSources(r.sources); setWarnings(r.discoveryErrors?.map(e=>e.error)??[]); },[]);
  const generation=useRef(0);
  const loadEvents=useCallback(async()=>{
    const request=++generation.current; setLoading(true); setEvents([]);
    try {
      const q=new URLSearchParams({start:window.start,end:window.end});
      const r=await api.get<{events:EventRow[];sourceErrors?:Array<{error:string}>}>(`/calendar/events?${q}`);
      if(request!==generation.current)return;
      setEvents(r.events); setWarnings(old=>[...old,...(r.sourceErrors?.map(e=>e.error)??[])]);
    } finally { if(request===generation.current)setLoading(false); }
  },[window]);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    void loadSources().then(()=>active?loadEvents():undefined).catch(e=>{if(active){setError(e instanceof Error?e.message:'Could not load calendars');setLoading(false);}});
    return ()=>{active=false;generation.current++;};
  },[loadSources,loadEvents]);
  async function select(source:Source){ setSources(rows=>rows.map(r=>r.id===source.id?{...r,selected:!r.selected}:r)); try{await api.put(`/calendar/sources/${source.id}`,{selected:!source.selected});await loadEvents();}catch(e){setError(e instanceof Error?e.message:'Could not change that calendar');await loadSources();}}
  async function makeWriteDefault(source:Source){ try{await api.put(`/calendar/sources/${source.id}`,{writeDefault:true});await loadSources();}catch(e){setError(e instanceof Error?e.message:'Could not set the default calendar');await loadSources();}}
  async function inspect(event:EventRow){ try{const r=await api.get<{event:any}>(`/calendar/events/${event.sourceId}/${encodeURIComponent(event.eventId)}`);setDetail({...r.event,sourceName:event.sourceName,account:event.account,provider:event.provider,connectionId:event.connectionId});}catch(e){setError(e instanceof Error?e.message:'Could not load that event');}}
  function move(direction:number){setAnchor(moveCalendar(anchor,view,direction));}
  const eventButton=(e:EventRow, compact=false, timed=false, allDayStrip=false)=>{
    const title=e.title||'Untitled event';
    const time=e.allDay?'All day':e.start?new Date(e.start).toLocaleTimeString([], {timeZone:zone,hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Unknown time';
    const repeatedCivilMinute=timed&&e.start?[-3600000,3600000].some(delta=>{
      const format=(value:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
      return format(Date.parse(e.start!))===format(Date.parse(e.start!)+delta);
    }):false;
    const displayTimeOptions:Intl.DateTimeFormatOptions={timeZone:zone,hour:'numeric',minute:'2-digit'};
    if(repeatedCivilMinute) displayTimeOptions.timeZoneName='short';
    const displayTime=timed&&e.start?new Date(e.start).toLocaleTimeString([],displayTimeOptions):time;
    const sourceColor=e.sourceColor||'#7c3aed';
    const metadata=`${e.sourceName} · ${plain('calendar_provider', e.provider)} · ${e.account||e.connectionId}`;
    return <button type="button" key={`${e.sourceId}:${e.eventId}`} title={`${title} — ${time} — ${metadata}`} aria-label={`${title}, ${time}, ${metadata}`} onClick={click=>{lastEventButton.current=click.currentTarget;void inspect(e);}} className={`${timed?'calendar-event-card':allDayStrip?'calendar-all-day-event':'w-full bg-background p-2'} rounded border border-border text-left hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary ${compact?'text-xs':'text-sm'}`} style={{borderLeftWidth:4,borderLeftColor:sourceColor,...(timed||allDayStrip?{'--calendar-event-color':sourceColor} as React.CSSProperties:{})}}>{timed?<><span className="calendar-event-time">{displayTime}</span><span className="calendar-event-title">{title}</span><span className="calendar-event-metadata">{metadata}</span></>:allDayStrip?<span className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium">{title}</span>:<><span className="block font-medium">{title}</span><span className="block">{time}</span><span className="block text-muted-foreground">{metadata}</span></>}</button>;
  };
  function gridKey(event:React.KeyboardEvent<HTMLDivElement>){
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-day]')); const index=buttons.indexOf(event.target as HTMLButtonElement);
    const delta:Record<string,number>={ArrowRight:1,ArrowLeft:-1,ArrowDown:7,ArrowUp:-7,Home:-index,End:buttons.length-1-index};
    if(index>=0 && event.key in delta){event.preventDefault();buttons[Math.max(0,Math.min(buttons.length-1,index+delta[event.key]))]?.focus();}
  }
  function renderTimeGrid(){
    const hours=Array.from({length:24},(_,hour)=>hour);
    return <div className="calendar-time-grid-scroll"><div className="calendar-time-grid-frame grid" style={{minWidth:view==='week'?1252:496,gridTemplateColumns:`4.75rem repeat(${window.days.length}, minmax(${view==='week'?'10.5rem':'26.25rem'}, 1fr))`}}>
      <div className="h-12 border border-border bg-card" aria-hidden="true"/>
      {window.days.map(day=>{const date=midnight(day,zone);return <h2 key={`heading:${day}`} aria-label={calendarDayLabel(day,zone)} className="flex h-12 flex-col items-center justify-center border border-border bg-card leading-tight"><span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{new Intl.DateTimeFormat(undefined,{timeZone:zone,weekday:'short'}).format(date)}</span><span className="text-sm font-semibold">{new Intl.DateTimeFormat(undefined,{timeZone:zone,day:'numeric'}).format(date)}</span></h2>;})}
      <div className="border border-border bg-card p-2 text-xs font-medium text-muted-foreground">All day</div>
      {window.days.map(day=>{const rows=eventsOnDay(events,day,zone);return <div key={`all-day:${day}`} className="min-h-12 space-y-1 border border-border bg-card p-1" aria-label={`All-day events ${day}`}>{rows.filter(e=>e.allDay).map(e=>eventButton(e,true,false,true))}</div>;})}
      <div className="calendar-time-axis relative h-[2304px] border border-border" aria-hidden="true">{hours.map(hour=><div key={hour} className="absolute inset-x-0 border-t border-border pr-2 text-right text-[11px] tabular-nums text-muted-foreground" style={{top:`${hour/24*100}%`}}>{new Date(Date.UTC(2000,0,1,hour)).toLocaleTimeString([], {timeZone:'UTC',hour:'numeric',minute:'2-digit'})}</div>)}</div>
      {window.days.map(day=>{const rows=eventsOnDay(events,day,zone);return <div key={`timed:${day}`} className="calendar-time-grid relative h-[2304px] border border-border" aria-label={`Timed events ${day}`}>{hours.map(hour=><div key={hour} aria-hidden="true" className="absolute inset-x-0 border-t border-border" style={{top:`${hour/24*100}%`}}/>)}{layoutEvents(rows,day,zone).map(row=><div key={`${row.event.sourceId}:${row.event.eventId}`} className="calendar-time-event" data-calendar-event-duration={Math.round((row.end-row.start)/60000)} style={{top:`${row.top}%`,height:`${row.height}%`,left:`${row.column/row.columns*100}%`,width:`${100/row.columns}%`}}>{eventButton(row.event,true,true)}</div>)}</div>;})}
    </div></div>;
  }
  return <div data-testid="calendar-page" className="w-full min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Calendar</h1><p className="text-sm text-muted-foreground">One view of the calendars you choose from all your connected accounts.</p></div><Button variant="secondary" onClick={()=>void loadSources(true).then(loadEvents).catch(e=>setError(String(e)))}>Refresh calendars</Button></div>
    {error?<ErrorNote>{error}</ErrorNote>:null}
    {warnings.length?<ErrorNote>{[...new Set(warnings)].join(' ')}</ErrorNote>:null}
    <section aria-label="Calendar schedule" className="space-y-4"><div className="flex flex-wrap items-center gap-2"><Button variant="secondary" onClick={()=>move(-1)}>Previous</Button><input aria-label="Calendar date" className="h-11 rounded-md border border-border bg-background px-3" type="date" value={anchor} onChange={e=>{if(e.target.value)setAnchor(e.target.value);}}/><Button variant="secondary" onClick={()=>move(1)}>Next</Button><Button variant="secondary" onClick={()=>setAnchor(dayKey(new Date(),zone))}>Today</Button><div className="sm:ml-auto">{(['list','month','week','day'] as View[]).map(v=><Button key={v} aria-pressed={view===v} variant={view===v?'primary':'secondary'} className="ml-1 capitalize" onClick={()=>setView(v)}>{v}</Button>)}</div></div>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">Timezone<select aria-label="Calendar timezone" className="max-w-full rounded border border-border bg-background p-2" value={zone} onChange={e=>setZone(e.target.value)}>{[...new Set([zone,'UTC',...Intl.supportedValuesOf('timeZone')])].map(z=><option key={z}>{z}</option>)}</select></label>
      <div className="mt-4" aria-busy={loading} aria-label={`${view} calendar`}>
        {loading?<p role="status">Loading…</p>:<>
          {!events.length?<p role="status" className="mb-3 text-muted-foreground">No events in this range.</p>:null}
          {view==='list'?<div className="space-y-4">{window.days.map(day=>{const rows=eventsOnDay(events,day,zone);return rows.length?<section key={day}><h2 className="mb-2 font-semibold">{calendarDayLabel(day,zone)}</h2><div className="space-y-2">{rows.map(e=>eventButton(e))}</div></section>:null;})}</div>:view==='month'?<div className="overflow-x-auto"><div className="grid min-w-[560px] grid-cols-7" onKeyDown={gridKey} aria-label="Month dates">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(label=><div key={label} className="border border-border p-2 text-sm font-semibold">{label}</div>)}{window.days.map(day=><section key={day} className={`min-h-28 border border-border p-1 ${day.slice(0,7)!==anchor.slice(0,7)?'bg-secondary/30':''}`}><button data-day type="button" className="mb-1 min-h-9 w-full rounded text-left font-medium focus-visible:ring-2 focus-visible:ring-primary" aria-label={`Open ${day}`} aria-current={dayKey(new Date(),zone)===day?'date':undefined} onClick={()=>{setAnchor(day);setView('day');}}>{day.slice(8)} {dayKey(new Date(),zone)===day?'· Today':''}</button><div className="space-y-1">{eventsOnDay(events,day,zone).map(e=>eventButton(e,true))}</div></section>)}</div></div>:renderTimeGrid()}
        </>}
      </div>
    </section>
    {detail?<section ref={detailRef} tabIndex={-1} aria-label="Event details"><Card><div className="flex justify-between gap-2"><CardTitle>{detail.title||'Untitled event'}</CardTitle><Button variant="secondary" onClick={()=>{setDetail(null);lastEventButton.current?.focus();}}>Close</Button></div><dl className="mt-3 space-y-2 text-sm"><div><dt className="text-muted-foreground">Calendar</dt><dd>{detail.sourceName} · {plain('calendar_provider', detail.provider)} · {detail.account||detail.connectionId}</dd></div><div><dt className="text-muted-foreground">When</dt><dd>{detail.start||'Unknown'} — {detail.end||'Unknown'}</dd></div>{detail.location?<div><dt className="text-muted-foreground">Location</dt><dd>{detail.location}</dd></div>:null}{detail.description?<div><dt className="text-muted-foreground">Details</dt><dd className="whitespace-pre-wrap">{detail.description}</dd></div>:null}</dl></Card></section>:null}
    <Card><CardTitle>Calendars</CardTitle>{sources.length?<div className="mt-3 grid gap-2 sm:grid-cols-2">{sources.map(s=><div key={s.id} className="flex min-h-11 flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 sm:flex-nowrap sm:py-0"><label className="flex min-w-0 basis-full items-center gap-3 sm:flex-1 sm:basis-auto"><input type="checkbox" checked={s.selected} onChange={()=>void select(s)}/><span className="h-3 w-3 rounded-full" style={{backgroundColor:s.color||'#f97316'}}/><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{s.name}</span><span className="block truncate text-xs text-muted-foreground">{plain('calendar_provider', s.provider)} · {s.account||s.connectionId}</span></span></label>{s.primary?<Badge>Primary</Badge>:null}{s.writable?<button type="button" className="rounded px-2 py-1 text-xs underline-offset-2 hover:underline" aria-pressed={s.writeDefault} onClick={()=>void makeWriteDefault(s)}>{s.writeDefault?'Write default':'Make default'}</button>:null}</div>)}</div>:<p className="mt-2 text-sm text-muted-foreground">No enabled calendar connection yet. Connect Google or Microsoft and turn on calendar reading.</p>}</Card>
  </div>;
}

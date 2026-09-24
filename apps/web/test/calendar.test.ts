import { describe,it,expect } from 'vitest';
import { calendarDayLabel, calendarRange, dayKey, eventsOnDay, layoutEvents, moveCalendar } from '../src/lib/calendar.js';
const zone='America/Los_Angeles';
describe('civil calendar views',()=>{
  it('uses the local today across UTC midnight',()=>expect(dayKey(new Date('2026-09-04T01:00:00Z'),zone)).toBe('2026-09-03'));
  it('formats localized weekday and human date labels in the selected zone',()=>{
    expect(calendarDayLabel('2026-09-17',zone,'en-US')).toBe('Thursday, Sep 17, 2026');
    expect(calendarDayLabel('2026-09-18','Pacific/Auckland','en-US')).toBe('Friday, Sep 18, 2026');
  });
  it.each([['2026-03-08',23],['2026-11-01',25]])('bounds DST day %s independently', (day,hours)=>{const r=calendarRange(String(day),'day',zone);expect((Date.parse(r.end)-Date.parse(r.start))/3600000).toBe(hours);});
  it('uses actual month navigation instead of thirty days',()=>{expect(moveCalendar('2026-01-31','month',1)).toBe('2026-02-01');expect(moveCalendar('2026-03-31','month',-1)).toBe('2026-02-01');});
  it('builds a six week grid and an explicit seven day list',()=>{expect(calendarRange('2026-03-31','month',zone).days).toHaveLength(42);expect(calendarRange('2026-03-31','list',zone).days[0]).toBe('2026-03-31');});
  it('keeps all day dates timezone independent and end exclusive',()=>{const e={start:'2026-03-08',end:'2026-03-10',allDay:true};expect(eventsOnDay([e],'2026-03-07',zone)).toEqual([]);expect(eventsOnDay([e],'2026-03-09','Pacific/Auckland')).toEqual([e]);expect(eventsOnDay([e],'2026-03-10',zone)).toEqual([]);});
  it('keeps separate recurrence instances, includes overnight events and partitions overlaps',()=>{const es=[{start:'2026-09-04T06:30:00Z',end:'2026-09-04T08:30:00Z',allDay:false},{start:'2026-09-04T08:00:00Z',end:'2026-09-04T09:00:00Z',allDay:false},{start:'2026-09-05T08:00:00Z',end:'2026-09-05T09:00:00Z',allDay:false}];const day=eventsOnDay(es,'2026-09-04',zone);expect(day).toHaveLength(2);const rows=layoutEvents(day,'2026-09-04',zone);expect(rows.map(r=>r.column)).toEqual([0,1]);expect(rows.map(r=>r.columns)).toEqual([2,2]);expect(rows[0].top).toBe(0);});
  it('does not group adjacent intervals as overlapping',()=>{const es=[{start:'2026-09-04T08:00:00Z',end:'2026-09-04T09:00:00Z',allDay:false},{start:'2026-09-04T09:00:00Z',end:'2026-09-04T10:00:00Z',allDay:false}];expect(layoutEvents(es,'2026-09-04',zone).map(r=>r.columns)).toEqual([1,1]);});
  it.each([
    ['ordinary day','2026-09-17','2026-09-17T19:00:00Z','2026-09-17T19:30:00Z'],
    ['spring-forward day','2026-03-08','2026-03-08T19:00:00Z','2026-03-08T19:30:00Z'],
    ['fall-back day','2026-11-01','2026-11-01T20:00:00Z','2026-11-01T20:30:00Z'],
  ])('keeps noon at 12:00 and half an hour at 48px on an %s',(_label,day,start,end)=>{const [row]=layoutEvents([{start,end,allDay:false}],day,zone);expect(row.top*2304/100).toBeCloseTo(12*96,5);expect(row.height*2304/100).toBeCloseTo(48,5);});
  it('aligns spring-forward civil hours instead of skipping the 2 AM grid row',()=>{const [row]=layoutEvents([{start:'2026-03-08T10:00:00Z',end:'2026-03-08T10:30:00Z',allDay:false}],'2026-03-08',zone);expect(row.top*2304/100).toBeCloseTo(3*96,5);});
  it('places repeated fall-back 1:30 instances on one civil line in separate visible columns',()=>{const rows=layoutEvents([{start:'2026-11-01T08:30:00Z',end:'2026-11-01T08:45:00Z',allDay:false},{start:'2026-11-01T09:30:00Z',end:'2026-11-01T09:45:00Z',allDay:false}],'2026-11-01',zone);expect(rows.map(row=>row.top*2304/100)).toEqual([144,144]);expect(rows.map(row=>row.column)).toEqual([0,1]);expect(rows.map(row=>row.columns)).toEqual([2,2]);});
});

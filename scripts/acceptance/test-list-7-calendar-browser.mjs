// Real rendered UI with synthetic provider responses; no live account or credentials.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const browser=await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{});
const results=[];
const artifactDir=resolve(process.env.E2E_ARTIFACT_DIR??'artifacts/calendar-event-cards');
await mkdir(artifactDir,{recursive:true});
try {
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const page=await browser.newPage({viewport,timezoneId:'America/Los_Angeles',...(viewport.width<500?{hasTouch:true,isMobile:true}:{})});let empty=false,fail=false;
  const source={id:'source-a',connectionId:'connection-a',name:'Team',account:'calendar-fixture@example.test',provider:'google',selected:true,primary:true,writable:true,writeDefault:true,color:'#7c3aed'};
  const event=(id,title,start,end,allDay=false)=>({eventId:id,sourceId:source.id,sourceName:source.name,account:source.account,provider:source.provider,sourceColor:source.color,title,start,end,allDay});
  const events=[event('a','Morning meeting','2026-03-08T09:30:00Z','2026-03-08T11:30:00Z'),event('b','Overlapping meeting','2026-03-08T10:00:00Z','2026-03-08T12:00:00Z'),event('short-30','Discover AI opportunities with a long title','2026-03-08T19:00:00Z','2026-03-08T19:30:00Z'),event('short-45','Zoom group follow-up with a long title','2026-03-08T19:00:00Z','2026-03-08T19:45:00Z'),event('c','All day workshop','2026-03-08','2026-03-09',true),event('series-1','Recurring meeting','2026-03-09T16:00:00Z','2026-03-09T17:00:00Z'),event('fall-pdt','First repeated 1:30','2026-11-01T08:30:00Z','2026-11-01T09:00:00Z'),event('fall-pst','Second repeated 1:30','2026-11-01T09:30:00Z','2026-11-01T10:00:00Z')];
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
   if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'proof',username:'owner',role:'super_admin'}}});
   if(path==='/api/calendar/sources')return route.fulfill({json:{sources:[source]}});
   if(path==='/api/calendar/events'){await new Promise(resolve=>setTimeout(resolve,150));return fail?route.fulfill({status:503,json:{error:'Calendar temporarily unavailable'}}):route.fulfill({json:{events:empty?[]:events}});}
   if(path.startsWith('/api/calendar/events/')){const id=decodeURIComponent(path.split('/').at(-1));const selected=events.find(item=>item.eventId===id)??events[0];return route.fulfill({json:{event:{...selected,description:'Synthetic acceptance fixture'}}});}
   return route.fulfill({json:{}});
  });
  await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18492')+'/app/calendar');
  await page.getByLabel('Calendar date').fill('2026-03-08');
  await page.getByRole('button',{name:/^Day$/i}).click();
  await page.getByText('Loading…',{exact:true}).waitFor();
  await page.getByRole('button',{name:/Morning meeting/}).waitFor();
  const pageBox=await page.getByTestId('calendar-page').boundingBox();
  const scheduleCardBox=await page.getByLabel('day calendar').locator('..').boundingBox();
  const pickerCardBox=await page.getByRole('heading',{name:'Calendars',exact:true}).locator('..').boundingBox();
  assert(pageBox&&scheduleCardBox&&pickerCardBox);
  assert(pickerCardBox.y>=scheduleCardBox.y+scheduleCardBox.height-1,'calendar picker must render after the complete schedule card');
  assert(Math.abs(pickerCardBox.width-scheduleCardBox.width)<1,'calendar picker and schedule must share the same full-width container');
  for(const control of [page.getByText('Primary',{exact:true}),page.getByRole('button',{name:'Write default',exact:true})]){const box=await control.boundingBox();assert(box&&box.x>=pickerCardBox.x&&box.x+box.width<=pickerCardBox.x+pickerCardBox.width,'calendar source controls must remain inside the picker card');}
  let widePageWidthRatio=null,wideScreenshot=null;
  if(viewport.width===1440){
   await page.setViewportSize({width:1920,height:1080});
   const widePageBox=await page.getByTestId('calendar-page').boundingBox();assert(widePageBox);
   widePageWidthRatio=widePageBox.width/1920;
   assert(widePageWidthRatio>=0.8,`calendar page should use at least 80% of the desktop viewport, received ${widePageWidthRatio}`);
   wideScreenshot=resolve(artifactDir,'calendar-full-width-1920x1080.png');await page.screenshot({path:wideScreenshot,fullPage:true});
   await page.setViewportSize(viewport);
  }
  const positions=await page.getByRole('button',{name:/Morning meeting|Overlapping meeting/}).evaluateAll(nodes=>nodes.map(n=>({left:n.parentElement.style.left,width:n.parentElement.style.width})));
  assert.deepEqual(positions.map(p=>p.width),['50%','50%']);assert.notEqual(positions[0].left,positions[1].left);
  const shortCards=page.locator('.calendar-time-event').filter({has:page.getByRole('button',{name:/Discover AI opportunities|Zoom group follow-up/})});
  assert.equal(await shortCards.count(),2);
  const shortGeometry=await shortCards.evaluateAll(nodes=>nodes.map(slot=>{const card=slot.querySelector('button');const title=slot.querySelector('.calendar-event-title');const time=slot.querySelector('.calendar-event-time');const metadata=slot.querySelector('.calendar-event-metadata');const slotStyle=getComputedStyle(slot);const cardStyle=getComputedStyle(card);const slotBox=slot.getBoundingClientRect();const cardBox=card.getBoundingClientRect();return {duration:slot.getAttribute('data-calendar-event-duration'),left:slot.style.left,width:slot.style.width,slotOverflowX:slotStyle.overflowX,slotOverflowY:slotStyle.overflowY,cardOverflowX:cardStyle.overflowX,cardOverflowY:cardStyle.overflowY,slotWidth:slotBox.width,slotHeight:slotBox.height,cardWidth:cardBox.width,cardHeight:cardBox.height,cardScrollWidth:card.scrollWidth,cardScrollHeight:card.scrollHeight,titleVisible:title.getBoundingClientRect().height>0,timeVisible:getComputedStyle(time).display!=='none',metadataVisible:getComputedStyle(metadata).display!=='none',titleAttr:card.getAttribute('title'),ariaLabel:card.getAttribute('aria-label')};}));
  assert.deepEqual(shortGeometry.map(card=>card.duration),['30','45']);
  assert.deepEqual(shortGeometry.map(card=>card.width),['50%','50%']);
  assert.notEqual(shortGeometry[0].left,shortGeometry[1].left);
  assert(Math.abs(shortGeometry[0].slotHeight-48)<0.6,'30-minute event should receive 48px');
  assert(Math.abs(shortGeometry[1].slotHeight-72)<0.6,'45-minute event should receive 72px');
  for(const card of shortGeometry){assert.equal(card.slotOverflowX,'hidden');assert.equal(card.slotOverflowY,'hidden');assert.equal(card.cardOverflowX,'hidden');assert.equal(card.cardOverflowY,'hidden');assert(card.cardWidth<=card.slotWidth+0.5);assert(card.cardHeight<=card.slotHeight+0.5);assert(card.cardScrollWidth<=card.cardWidth+1);assert(card.cardScrollHeight<=card.cardHeight+1);assert(card.titleVisible);assert(card.timeVisible);assert.equal(card.metadataVisible,false);assert.match(card.titleAttr,/calendar-fixture@example\.test/);assert.match(card.ariaLabel,/calendar-fixture@example\.test/);}
  const gridGeometry=await page.locator('.calendar-time-grid').first().evaluate(grid=>({height:grid.getBoundingClientRect().height,dayWidth:grid.getBoundingClientRect().width}));
  assert.equal(gridGeometry.height,2304);assert(gridGeometry.dayWidth>=159,'week day columns should remain readable');
  const calendarScroller=await page.locator('.calendar-time-grid-scroll').evaluate(scroller=>{scroller.scrollTop=200;const style=getComputedStyle(scroller);return {clientHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,scrollTop:scroller.scrollTop,overflowY:style.overflowY,maxHeight:style.maxHeight};});
  assert(Math.abs(calendarScroller.scrollHeight-calendarScroller.clientHeight)<=1,'time grid must expand naturally without an inner vertical viewport');assert.equal(calendarScroller.scrollTop,0,'time grid must not own vertical scrolling');assert.equal(calendarScroller.maxHeight,'none');
  assert.equal(await page.locator('.calendar-time-grid-frame h2').first().evaluate(header=>getComputedStyle(header).position),'static');
  await page.getByRole('button',{name:/Discover AI opportunities/}).scrollIntoViewIfNeeded();
  const dayScreenshot=resolve(artifactDir,`calendar-day-short-events-${viewport.width}x${viewport.height}.png`);
  await page.screenshot({path:dayScreenshot,fullPage:true});
  if(viewport.width<500){await page.getByRole('button',{name:/Discover AI opportunities/}).tap();await page.getByRole('region',{name:'Event details'}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).tap();}
  const allDayButton=page.getByRole('button',{name:/All day workshop/});assert.equal(await allDayButton.count(),1);assert((await allDayButton.boundingBox()).height>=44,'all-day event touch target must be at least 44px');
  await page.getByRole('button',{name:/Morning meeting/}).click();await page.getByRole('region',{name:'Event details'}).waitFor();assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Event details');await page.getByRole('button',{name:'Close',exact:true}).click();assert((await page.locator(':focus').innerText()).includes('Morning meeting'));
  await page.getByRole('button',{name:/^Month$/i}).click();
  await page.getByRole('button',{name:'Open 2026-03-08',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Open 2026-03-09');
  assert.equal(await page.locator('button[data-day]').count(),42);
  await page.getByRole('button',{name:/^List$/i}).click();await page.getByRole('button',{name:/Recurring meeting/}).waitFor();
  await page.getByRole('button',{name:/^Week$/i}).click();await page.getByText('Loading…',{exact:true}).waitFor();await page.getByRole('button',{name:/Discover AI opportunities/}).waitFor();assert.equal(await page.locator('[aria-label^="Timed events 2026-03-"]').count(),7);
  const horizontalScroller=await page.locator('.calendar-time-grid-scroll').evaluate(scroller=>({clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,overflowX:getComputedStyle(scroller).overflowX}));assert.equal(horizontalScroller.overflowX,'auto');assert(horizontalScroller.scrollWidth>horizontalScroller.clientWidth,'week grid owns horizontal scrolling when it cannot fit');
  const weekShortCards=page.locator('.calendar-time-event').filter({has:page.getByRole('button',{name:/Discover AI opportunities|Zoom group follow-up/})});assert.equal(await weekShortCards.count(),2);
  const weekGeometry=await weekShortCards.evaluateAll(nodes=>nodes.map(slot=>{const card=slot.querySelector('button');const slotBox=slot.getBoundingClientRect();const cardBox=card.getBoundingClientRect();return {slotOverflow:getComputedStyle(slot).overflow,cardOverflow:getComputedStyle(card).overflow,width:slotBox.width,height:slotBox.height,cardWidth:cardBox.width,cardHeight:cardBox.height,timeVisible:getComputedStyle(card.querySelector('.calendar-event-time')).display!=='none',titleVisible:card.querySelector('.calendar-event-title').getBoundingClientRect().height>0};}));
  for(const card of weekGeometry){assert.equal(card.slotOverflow,'hidden');assert.equal(card.cardOverflow,'hidden');assert(card.width>=76,'overlapping week cards should remain legible side-by-side');assert(card.cardWidth<=card.width+0.5);assert(card.cardHeight<=card.height+0.5);assert(card.timeVisible);assert(card.titleVisible);}
  const axisNoon=await page.locator('.calendar-time-axis > div').nth(12).boundingBox();const sundayNoon=await weekShortCards.first().boundingBox();assert(Math.abs(axisNoon.y-sundayNoon.y)<1,'DST Sunday noon must align to shared noon axis');
  const axisNine=await page.locator('.calendar-time-axis > div').nth(9).boundingBox();const mondayNine=await page.getByRole('button',{name:/Recurring meeting/}).locator('..').boundingBox();assert(Math.abs(axisNine.y-mondayNine.y)<1,'normal Monday 9 AM must align to shared 9 AM axis');
  await page.getByRole('button',{name:/Discover AI opportunities/}).scrollIntoViewIfNeeded();
  const weekScreenshot=resolve(artifactDir,`calendar-week-short-events-${viewport.width}x${viewport.height}.png`);await page.screenshot({path:weekScreenshot,fullPage:true});
  const weekGridScreenshot=resolve(artifactDir,`calendar-week-grid-${viewport.width}x${viewport.height}.png`);await page.locator('.calendar-time-grid-scroll').screenshot({path:weekGridScreenshot});
  await page.getByLabel('Calendar date').fill('2026-11-01');await page.getByRole('button',{name:/^Day$/i}).click();
  const repeated=page.locator('.calendar-time-event').filter({has:page.getByRole('button',{name:/First repeated 1:30|Second repeated 1:30/})});await repeated.first().waitFor();assert.equal(await repeated.count(),2);
  const repeatedGeometry=await repeated.evaluateAll(nodes=>nodes.map(slot=>({top:slot.style.top,left:slot.style.left,width:slot.style.width,height:slot.getBoundingClientRect().height,text:slot.innerText})));
  assert.deepEqual(repeatedGeometry.map(card=>card.top),[repeatedGeometry[0].top,repeatedGeometry[0].top]);assert.deepEqual(repeatedGeometry.map(card=>card.width),['50%','50%']);assert.notEqual(repeatedGeometry[0].left,repeatedGeometry[1].left);assert(repeatedGeometry.every(card=>card.height>=23&&card.text.includes('1:30 AM')));assert(repeatedGeometry.some(card=>card.text.includes('PDT')));assert(repeatedGeometry.some(card=>card.text.includes('PST')));
  for(const name of [/First repeated 1:30/,/Second repeated 1:30/]){const button=page.getByRole('button',{name});await button.focus();await page.keyboard.press('Enter');const details=page.getByRole('region',{name:'Event details'});await details.waitFor();assert((await details.innerText()).includes(name.source.includes('First')?'First repeated 1:30':'Second repeated 1:30'));await page.getByRole('button',{name:'Close',exact:true}).click();}
  const fallBackScreenshot=resolve(artifactDir,`calendar-fall-back-${viewport.width}x${viewport.height}.png`);await repeated.first().scrollIntoViewIfNeeded();await page.locator('.calendar-time-grid-scroll').screenshot({path:fallBackScreenshot});
  await page.getByRole('button',{name:'Today',exact:true}).click();
  assert.equal(await page.getByLabel('Calendar date').inputValue(),await page.evaluate(()=>new Intl.DateTimeFormat('en-CA').format(new Date())));
  await page.getByLabel('Calendar timezone').selectOption('UTC');
  empty=true;await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('No events in this range.',{exact:true}).waitFor();
  fail=true;await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('alert').filter({hasText:'Calendar temporarily unavailable'}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('heading',{name:'Calendars',exact:true}).scrollIntoViewIfNeeded();
  const pageScroll=await page.locator('main').evaluate(main=>({scrollTop:main.scrollTop,clientHeight:main.clientHeight,scrollHeight:main.scrollHeight}));assert(pageScroll.scrollTop>0&&pageScroll.scrollHeight>pageScroll.clientHeight,'the app page must own vertical scrolling to the picker');assert.equal(await page.locator('.calendar-time-grid-scroll').evaluate(scroller=>scroller.scrollTop),0);
  const pickerBelowScreenshot=resolve(artifactDir,`calendar-picker-below-${viewport.width}x${viewport.height}.png`);await page.screenshot({path:pickerBelowScreenshot,fullPage:true});
  results.push({viewport,screenshots:[dayScreenshot,weekScreenshot,weekGridScreenshot,fallBackScreenshot,pickerBelowScreenshot,...(wideScreenshot?[wideScreenshot]:[])],pageWidthRatio:Number((pageBox.width/viewport.width).toFixed(4)),...(widePageWidthRatio?{widePageWidthRatio:Number(widePageWidthRatio.toFixed(4))}:{}),checks:['full-width desktop container','schedule before aligned calendar picker','list/month/week/day','overlap columns','30/45-minute card containment','repeated fall-back hour columns and timezone labels','page-owned vertical scrolling with calendar horizontal overflow only','touch activation','44px all-day target','no event-card native scrollbars','full accessible event labels','all-day','recurrence instance','month keyboard arrows','detail focus and return','loading','today in local timezone','timezone selector','empty','error','no page horizontal overflow']});await page.close();
 }
 console.log(JSON.stringify({pass:true,provider:'synthetic fixtures',results},null,2));
} finally {await browser.close();}

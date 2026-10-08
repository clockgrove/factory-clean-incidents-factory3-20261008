import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {createServer} from '../app/server.mjs';
const datasetPath=new URL('../.runtime/incidents.json',import.meta.url);
const fields=['id','title','description','service','severity','status','openedAt','resolvedAt','team','region','tags'];
const weight={critical:4,high:3,medium:2,low:1};
function expected(rows,p){return rows.filter(r=>['id','title','description'].some(k=>r[k].toLowerCase().includes((p.get('q')||'').toLowerCase()))&&['service','severity','status'].every(k=>!p.getAll(k).length||p.getAll(k).includes(r[k]))&&(!p.get('from')||r.openedAt.substring(0,10)>=p.get('from'))&&(!p.get('to')||r.openedAt.substring(0,10)<=p.get('to'))).sort((a,b)=>{const cmp=p.get('sort')==='severity'?weight[a.severity]-weight[b.severity]:Date.parse(a.openedAt)-Date.parse(b.openedAt);return cmp*(p.get('direction')==='asc'?1:-1)||a.id.localeCompare(b.id);});}
function parseCSV(text){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if(c==='\r'&&text[i+1]==='\n'&&!quoted){row.push(value);rows.push(row);row=[];value='';i++;}else value+=c;}assert.equal(quoted,false);return rows;}
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));}

test('real HTTP: independently derived queries, summaries, details and complete CSV',async()=>{
 const before=await readFile(datasetPath),rows=JSON.parse(before);const server=await createServer();const base=await listen(server);
 try{
  const cases=['','q=INC-000001','q=FICTIONAL','q=%22retry%2C+then+continue%22','q=%3Csample%3E','q=.*','service=Billing&service=Search&status=open&status=in_progress&severity=critical&severity=high&from=2026-04-10&to=2026-05-10','from=2026-04-01&to=2026-04-01','from=2026-06-29&to=2026-06-29'];
  for(const sort of ['openedAt','severity'])for(const direction of ['asc','desc'])cases.push(`sort=${sort}&direction=${direction}`);
  for(const qs of cases){const p=new URLSearchParams(qs),all=expected(rows,p);for(const size of [25,50]){
   p.set('size',size);p.set('page',1);const result=await (await fetch(base+'/api/incidents?'+p)).json();assert.deepEqual(result.rows,all.slice(0,size));assert.equal(result.total,all.length);assert.equal(result.unresolved,all.filter(r=>r.status==='open'||r.status==='in_progress').length);assert.equal(result.high,all.filter(r=>weight[r.severity]>=3).length);
   const days=new Map();for(const r of all)days.set(r.openedAt.slice(0,10),(days.get(r.openedAt.slice(0,10))||0)+1);assert.deepEqual(result.daily,[...days].sort());
   p.set('page',99999);const last=await(await fetch(base+'/api/incidents?'+p)).json();assert.equal(last.page,Math.max(1,Math.ceil(all.length/size)));assert.deepEqual(last.rows,all.slice((last.page-1)*size,last.page*size));
  }
  const csv=parseCSV(await(await fetch(base+'/api/export?'+p)).text());assert.deepEqual(csv[0],fields);assert.deepEqual(csv.slice(1),all.map(r=>fields.map(k=>k==='tags'?JSON.stringify(r[k]):String(r[k]??''))));
  }
  assert.equal((await(await fetch(base+'/api/incidents?sort=severity')).json()).rows[0].severity,'critical');
  for(const row of [rows[0],rows[1],rows.find(r=>r.status==='resolved')])assert.deepEqual(await(await fetch(base+'/api/incidents/'+row.id)).json(),row);
  assert.equal((await fetch(base+'/api/incidents/missing')).status,404);
 }finally{await close(server);assert.deepEqual(await readFile(datasetPath),before);}
});

test('sandboxed real browser: journeys and overlapping real backend traffic', {timeout:120000},async()=>{
 const bytes=await readFile(datasetPath),rows=JSON.parse(bytes);await mkdir('.runtime/browser-tmp',{recursive:true});
 const alias=execFileSync('bash',['-c','command -v qualification-chromium'],{encoding:'utf8'}).trim(),tool=dirname(alias);
 process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(tool,'../browsers');const {chromium}=await import('playwright');
 // Gates delay genuine requests before the real backend handles them. Failures close
 // actual HTTP sockets; no responses, browser routes or application data are mocked.
 const gates=[],observed=[],bootstrapChecks=[];
 const server=await createServer({beforeRequest:async(req,res,url)=>{observed.push(url.pathname+url.search);const gate=gates.find(g=>g.active&&(!g.used||g.fail)&&g.match(url));if(gate){gate.used=true;gate.started();await gate.promise;if(gate.fail){res.destroy();return;}}}});
 const base=await listen(server);let browser,verificationPassed=false;
 function gate(match,fail=false){let release,started;const promise=new Promise(r=>release=r),begun=new Promise(r=>started=r);const g={active:true,match,fail,promise,release,started,begun};gates.push(g);return g;}
 try{
 browser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,env:{PATH:process.env.PATH,HOME:process.env.HOME,LD_LIBRARY_PATH:resolve(tool,'../host-libs/usr/lib/x86_64-linux-gnu'),ALSA_CONFIG_PATH:resolve(tool,'../host-libs/usr/share/alsa/alsa.conf'),TMPDIR:'.runtime/browser-tmp',TMP:'.runtime/browser-tmp',TEMP:'.runtime/browser-tmp'}});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();const search=page.getByLabel('Search incidents');
 const loaded=async()=>{await page.waitForFunction(()=>document.getElementById('status').textContent.endsWith('incidents loaded'));};
 const ids=()=>page.locator('#rows button').allTextContents();
 const pexpected=p=>expected(rows,new URLSearchParams(p));
 const initialOptions=gate(u=>u.pathname==='/api/options');
 await page.goto(base);await initialOptions.begun;await loaded();assert.deepEqual(await ids(),pexpected('').slice(0,25).map(r=>r.id));assert.equal(await search.inputValue(),'');assert.equal(await page.locator('#selections').textContent(),'All incidents · No filters applied');assert.equal(await page.getByLabel('Rows per page').inputValue(),'25');
 // Bootstrap must load results once without waiting for options. Navigate while
 // its real HTTP request is held, then allow it to complete over open details.
 assert.equal(await page.locator('#choices input').count(),0);
 await search.fill('InC-000001');await loaded();
 await page.locator('#rows button').first().click();
 await page.waitForFunction(()=>document.querySelectorAll('#detail-fields dd').length===11);
 const initialFields=await page.locator('#detail-fields dd').allTextContents();
 const initialQueries=observed.filter(u=>u.startsWith('/api/incidents?')).length;
 initialOptions.release();
 await page.waitForFunction(()=>document.getElementById('options-status').textContent==='Filter choices ready.');
 assert.equal(observed.filter(u=>u.startsWith('/api/incidents?')).length,initialQueries);
 assert.equal(await page.locator('#detail').isVisible(),true);
 assert.deepEqual(await page.locator('#detail-fields dd').allTextContents(),initialFields);
 assert.deepEqual(await ids(),['INC-000001']);
 assert.equal(await search.inputValue(),'InC-000001');
 assert.equal(await page.locator('#retry').isVisible(),false);
 bootstrapChecks.push('initial options success preserves open details and does not reload results');
 await page.getByRole('button',{name:'Back to results'}).click();
 await page.getByRole('button',{name:'Clear filters'}).click();await loaded();

 // Save through the UI, then restore before any filter checkboxes exist.
 for(const label of ['Billing','Search','critical','high'])await page.getByLabel(label,{exact:true}).check();
 await page.getByLabel('Rows per page').selectOption('50');
 await page.getByLabel('Sort by').selectOption('severity');
 await page.getByLabel('Direction').selectOption('asc');
 await loaded();
 await page.getByLabel('View name').fill('Bootstrap triage');
 await page.getByRole('button',{name:'Save view',exact:true}).click();
 const bootstrapParams='service=Billing&service=Search&severity=critical&severity=high&sort=severity&direction=asc';
 for(const failure of [false,true]){
  const options=gate(u=>u.pathname==='/api/options',failure);
  await page.reload();await options.begun;await loaded();
  assert.equal(await page.locator('#choices input').count(),0);
  await page.getByLabel('Saved views').selectOption('Bootstrap triage');
  await page.getByRole('button',{name:'Open view',exact:true}).click();await loaded();
  const restored=pexpected(bootstrapParams).slice(0,50).map(r=>r.id);
  assert.deepEqual(await ids(),restored);
  assert.match(await page.locator('#selections').textContent(),/Billing, Search/);
  await page.locator('#rows button').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('#detail-fields dd').length===11);
  const detailFields=await page.locator('#detail-fields dd').allTextContents();
  const queryCount=observed.filter(u=>u.startsWith('/api/incidents?')).length;
  const resultStatus=await page.locator('#status').textContent();
  options.release();
  if(failure)await page.locator('#options-retry').waitFor({state:'visible'});
  else await page.waitForFunction(()=>document.getElementById('options-status').textContent==='Filter choices ready.');
  assert.equal(await page.locator('#detail').isVisible(),true);
  assert.deepEqual(await page.locator('#detail-fields dd').allTextContents(),detailFields);
  assert.deepEqual(await ids(),restored);
  assert.equal(await page.locator('#status').textContent(),resultStatus);
  assert.equal(await page.locator('#retry').isVisible(),false);
  assert.equal(observed.filter(u=>u.startsWith('/api/incidents?')).length,queryCount);
  if(failure){
   options.active=false;
   await page.getByRole('button',{name:'Retry filter choices',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('options-status').textContent==='Filter choices ready.');
   assert.equal(await page.locator('#detail').isVisible(),true);
   assert.equal(observed.filter(u=>u.startsWith('/api/incidents?')).length,queryCount);
   assert.equal(await page.locator('#status').textContent(),resultStatus);
  }
  for(const label of ['Billing','Search','critical','high'])assert.equal(await page.getByLabel(label,{exact:true}).isChecked(),true);
  await page.getByRole('button',{name:'Back to results'}).click();
  assert.deepEqual(await ids(),restored);
  bootstrapChecks.push(`options ${failure?'socket failure and metadata retry':'success'} preserves early saved filters, details and results`);

  // Release metadata while a newer result intent is still loading. Then fail
  // that result genuinely: metadata Retry must not seize result Retry ownership.
  const loadingOptions=gate(u=>u.pathname==='/api/options',failure);
  await page.reload();await loadingOptions.begun;await loaded();
  await page.getByLabel('Saved views').selectOption('Bootstrap triage');
  await page.getByRole('button',{name:'Open view',exact:true}).click();await loaded();
  const query=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='retry',true);
  await search.fill('retry');await query.begun;
  loadingOptions.release();
  if(failure)await page.locator('#options-retry').waitFor({state:'visible'});
  else await page.waitForFunction(()=>document.getElementById('options-status').textContent==='Filter choices ready.');
  assert.equal(await page.locator('#status').textContent(),'Loading incidents…');
  assert.equal(await page.locator('#results').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('#rows button').count(),0);
  assert.equal(await page.locator('#retry').isVisible(),false);
  query.release();await page.locator('#retry').waitFor({state:'visible'});query.active=false;
  const failedStatus=await page.locator('#status').textContent();
  const failedQueries=observed.filter(u=>u.startsWith('/api/incidents?')).length;
  if(failure){
   loadingOptions.active=false;
   await page.getByRole('button',{name:'Retry filter choices',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('options-status').textContent==='Filter choices ready.');
   assert.equal(await page.locator('#status').textContent(),failedStatus);
   assert.equal(await page.locator('#retry').isVisible(),true);
   assert.equal(observed.filter(u=>u.startsWith('/api/incidents?')).length,failedQueries);
  }
  assert.equal(await search.inputValue(),'retry');
  await page.getByRole('button',{name:'Retry',exact:true}).click();await loaded();
  assert.deepEqual(await ids(),pexpected(bootstrapParams+'&q=retry').slice(0,50).map(r=>r.id));
  for(const label of ['Billing','Search','critical','high'])assert.equal(await page.getByLabel(label,{exact:true}).isChecked(),true);
  bootstrapChecks.push(`options ${failure?'failure':'success'} preserves newer loading; result Retry uses restored current intent`);
 }
 await page.getByLabel('Saved views').selectOption('Bootstrap triage');
 await page.getByRole('button',{name:'Delete view',exact:true}).click();
 await page.getByRole('button',{name:'Clear filters'}).click();await loaded();
 await page.getByRole('button',{name:'Next',exact:true}).click();await loaded();assert.match(await page.locator('#page').textContent(),/Page 2/);
 await search.fill('InC-000001');await loaded();assert.deepEqual(await ids(),['INC-000001']);assert.match(await page.locator('#page').textContent(),/Page 1/);
 await search.fill('.*');await loaded();await page.locator('#empty').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Clear filters'}).click();await loaded();
 for(const label of ['Billing','Search','open','in_progress','critical','high'])await page.getByLabel(label,{exact:true}).check();
 await page.getByLabel('Opened from (UTC)').fill('2026-04-10');await page.getByLabel('Opened through (UTC)').fill('2026-05-10');await loaded();
 const combined='service=Billing&service=Search&status=open&status=in_progress&severity=critical&severity=high&from=2026-04-10&to=2026-05-10';
 assert.deepEqual(await ids(),pexpected(combined).slice(0,25).map(r=>r.id));assert.equal(await page.locator('#total').textContent(),String(pexpected(combined).length));assert.match(await page.locator('#selections').textContent(),/Billing, Search/);
 await page.getByRole('button',{name:'Clear filters'}).click();await loaded();
 await page.getByLabel('Opened from (UTC)').fill('2026-04-01');await page.getByLabel('Opened through (UTC)').fill('2026-04-01');await loaded();assert.deepEqual(await ids(),pexpected('from=2026-04-01&to=2026-04-01').slice(0,25).map(r=>r.id));
 await page.getByRole('button',{name:'Clear filters'}).click();await loaded();
 for(const sort of ['severity','openedAt'])for(const direction of ['asc','desc']){await page.getByRole('button',{name:'Next',exact:true}).click();await loaded();await page.getByLabel('Sort by').selectOption(sort);await page.getByLabel('Direction').selectOption(direction);await loaded();assert.deepEqual(await ids(),pexpected(`sort=${sort}&direction=${direction}`).slice(0,25).map(r=>r.id));assert.match(await page.locator('#page').textContent(),/Page 1/);}
 await page.getByLabel('Rows per page').selectOption('50');await loaded();assert.equal((await ids()).length,50);await page.getByRole('button',{name:'Next',exact:true}).click();await loaded();assert.deepEqual(await ids(),pexpected('').slice(50,100).map(r=>r.id));
 // Both keyboard defaults and preserved results after full details.
 const prior=await ids();await page.locator('#rows button').first().focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('#detail-fields dd').length===11);
 const detail=rows.find(r=>r.id===prior[0]);assert.deepEqual(await page.locator('#detail-fields dt').allTextContents(),fields);assert.deepEqual(await page.locator('#detail-fields dd').allTextContents(),fields.map(k=>Array.isArray(detail[k])?detail[k].join(', '):detail[k]??'—'));
 await page.getByRole('button',{name:'Back to results'}).click();assert.deepEqual(await ids(),prior);assert.match(await page.locator('#page').textContent(),/Page 2/);
 await search.fill('retry');await page.getByLabel('Billing',{exact:true}).check();await page.getByLabel('critical',{exact:true}).check();await page.getByLabel('Sort by').selectOption('severity');await page.getByLabel('Direction').selectOption('asc');await page.getByLabel('Opened from (UTC)').fill('2026-04-01');await loaded();const savedIds=await ids();await page.getByLabel('View name').fill('Morning triage');await page.getByRole('button',{name:'Save view',exact:true}).click();await page.reload();await loaded();await page.getByLabel('Saved views').selectOption('Morning triage');const restoreOld=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Notifications',true);await search.fill('Notifications');await restoreOld.begun;await page.getByRole('button',{name:'Open view',exact:true}).click();await loaded();assert.equal(await page.getByLabel('Rows per page').inputValue(),'50');assert.equal(await search.inputValue(),'retry');assert.equal(await page.getByLabel('Billing',{exact:true}).isChecked(),true);assert.equal(await page.getByLabel('critical',{exact:true}).isChecked(),true);assert.equal(await page.getByLabel('Sort by').inputValue(),'severity');assert.equal(await page.getByLabel('Direction').inputValue(),'asc');assert.equal(await page.getByLabel('Opened from (UTC)').inputValue(),'2026-04-01');assert.deepEqual(await ids(),savedIds);restoreOld.release();await page.waitForTimeout(100);restoreOld.active=false;assert.deepEqual(await ids(),savedIds);assert.equal(await page.locator('#retry').isVisible(),false);
 await page.getByRole('button',{name:'Delete view',exact:true}).click();await page.reload();await loaded();assert.equal(await page.getByLabel('Saved views').locator('option').count(),1);
 const downloadWait=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();const download=await downloadWait;await download.saveAs('.runtime/browser-export.csv');const browserCSV=parseCSV(await readFile('.runtime/browser-export.csv','utf8'));assert.deepEqual(browserCSV[0],fields);assert.deepEqual(browserCSV.slice(1),pexpected('').map(r=>fields.map(k=>k==='tags'?JSON.stringify(r[k]):String(r[k]??''))));
 await page.getByText('Daily counts — text alternative').click();assert.equal(await page.locator('#daily li').count(),90);const dailyExpected=new Map();for(const row of rows)dailyExpected.set(row.openedAt.slice(0,10),(dailyExpected.get(row.openedAt.slice(0,10))||0)+1);assert.deepEqual(await page.locator('#daily li').allTextContents(),[...dailyExpected].sort().map(([day,count])=>`${day}: ${count} incidents`));assert.equal(await page.locator('#total').textContent(),'2,400');assert.equal(await page.locator('#unresolved').textContent(),rows.filter(r=>r.status!=='resolved').length.toLocaleString());assert.equal(await page.locator('#high').textContent(),rows.filter(r=>weight[r.severity]>=3).length.toLocaleString());
 // Hold an old successful request, then change intent; releasing it must not alter current results.
 const old=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Billing');await search.fill('Billing');await old.begun;assert.match(await page.locator('#status').textContent(),/Loading/);await search.fill('INC-000001');await loaded();old.release();await page.waitForTimeout(100);assert.deepEqual(await ids(),['INC-000001']);
 const failedOld=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Search',true);await search.fill('Search');await failedOld.begun;const newer=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Uploads');await search.fill('Uploads');await newer.begun;failedOld.release();await page.waitForTimeout(100);assert.match(await page.locator('#status').textContent(),/Loading/);assert.equal(await page.locator('#retry').isVisible(),false);failedOld.active=false;newer.release();await loaded();assert.deepEqual(await ids(),pexpected('q=Uploads').slice(0,25).map(r=>r.id));
 // Late success cleanup cannot clear a newer request's loading state.
 const successOld=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Billing');await search.fill('Billing');await successOld.begun;const successNew=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Accounts');await search.fill('Accounts');await successNew.begun;successOld.release();await page.waitForTimeout(100);assert.match(await page.locator('#status').textContent(),/Loading/);assert.equal(await page.locator('#rows button').count(),0);successNew.release();await loaded();assert.deepEqual(await ids(),pexpected('q=Accounts').slice(0,25).map(r=>r.id));
 // Genuine connection failures, retained selections and current-intent Retry.
 const fail=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Notifications',true);await search.fill('Notifications');await fail.begun;fail.release();await page.locator('#retry').waitFor({state:'visible'});assert.equal(await search.inputValue(),'Notifications');fail.active=false;await page.getByRole('button',{name:'Retry',exact:true}).click();await loaded();assert.deepEqual(await ids(),pexpected('q=Notifications').slice(0,25).map(r=>r.id));
 const changed=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('q')==='Integrations',true);await search.fill('Integrations');await changed.begun;changed.release();await page.locator('#retry').waitFor({state:'visible'});changed.active=false;await search.fill('Accounts');await loaded();assert.equal(await page.locator('#retry').isVisible(),false);assert.deepEqual(await ids(),pexpected('q=Accounts').slice(0,25).map(r=>r.id));
 // Closing and switching details while their real HTTP work is delayed.
 await page.getByRole('button',{name:'Clear filters'}).click();await loaded();const firstIds=await ids();const closed=gate(u=>u.pathname==='/api/incidents/'+firstIds[0]);await page.locator('#rows button').first().click();await closed.begun;await page.getByRole('button',{name:'Back to results'}).click();closed.release();await page.waitForTimeout(100);assert.equal(await page.locator('#detail').isVisible(),false);assert.deepEqual(await ids(),firstIds);
 const switching=gate(u=>u.pathname==='/api/incidents/'+firstIds[0],true);await page.locator('#rows button').first().click();await switching.begun;await page.getByRole('button',{name:'Back to results'}).click();await page.locator('#rows button').nth(1).click();await page.waitForFunction(()=>document.querySelectorAll('#detail-fields dd').length===11);switching.release();await page.waitForTimeout(100);switching.active=false;assert.equal(await page.locator('#detail-title').textContent(),firstIds[1]);assert.equal(await page.locator('#detail-retry').isVisible(),false);await page.getByRole('button',{name:'Back to results'}).click();
 // A late successful closed detail cannot populate a newly loading detail.
 const lateDetail=gate(u=>u.pathname==='/api/incidents/'+firstIds[0]);await page.locator('#rows button').first().click();await lateDetail.begun;await page.getByRole('button',{name:'Back to results'}).click();const newDetail=gate(u=>u.pathname==='/api/incidents/'+firstIds[1]);await page.locator('#rows button').nth(1).click();await newDetail.begun;lateDetail.release();await page.waitForTimeout(100);assert.match(await page.locator('#detail-status').textContent(),/Loading/);assert.equal(await page.locator('#detail-fields dd').count(),0);newDetail.release();await page.waitForFunction(()=>document.querySelectorAll('#detail-fields dd').length===11);assert.equal(await page.locator('#detail-title').textContent(),firstIds[1]);await page.getByRole('button',{name:'Back to results'}).click();
 const detailFail=gate(u=>u.pathname==='/api/incidents/'+firstIds[0],true);await page.locator('#rows button').first().click();await detailFail.begun;detailFail.release();await page.locator('#detail-retry').waitFor({state:'visible'});detailFail.active=false;await page.getByRole('button',{name:'Retry details',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#detail-fields dd').length===11);await page.getByRole('button',{name:'Back to results'}).click();
 // Filter changes supersede a still-loading detail, including a late failure.
 const supersededDetail=gate(u=>u.pathname==='/api/incidents/'+firstIds[0],true);await page.locator('#rows button').first().click();await supersededDetail.begun;await search.fill('INC-000001');await loaded();supersededDetail.release();await page.waitForTimeout(100);supersededDetail.active=false;assert.equal(await page.locator('#detail').isVisible(),false);assert.deepEqual(await ids(),['INC-000001']);
 // Delayed export completion/failure cannot report against a newer selection.
 for(const failure of [false,true]){const exp=gate(u=>u.pathname==='/api/export',failure);await page.getByRole('button',{name:'Export CSV',exact:true}).click();await exp.begun;await search.fill(failure?'Search':'Billing');await loaded();exp.release();await page.waitForTimeout(100);assert.equal(await page.locator('#export-status').textContent(),'');assert.equal(await page.locator('#export').isEnabled(),true);exp.active=false;}
 await search.fill('<sample>');await page.getByLabel('Sort by').selectOption('severity');await page.getByLabel('Direction').selectOption('asc');await loaded();const filteredDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();await (await filteredDownload).saveAs('.runtime/browser-filtered-export.csv');const filteredCSV=parseCSV(await readFile('.runtime/browser-filtered-export.csv','utf8'));assert.deepEqual(filteredCSV.slice(1),pexpected('q=%3Csample%3E&sort=severity&direction=asc').map(r=>fields.map(k=>k==='tags'?JSON.stringify(r[k]):String(r[k]??''))));
 // Rapid genuine button actions, including bounds and reset while pagination is pending.
 await page.getByRole('button',{name:'Clear filters'}).click();await loaded();const paging=gate(u=>u.pathname==='/api/incidents'&&u.searchParams.get('page')==='2');await page.getByRole('button',{name:'Next',exact:true}).click();await paging.begun;await page.keyboard.press('Enter');await page.keyboard.press('Enter');assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);await search.fill('INC-000001');await loaded();paging.release();await page.waitForTimeout(100);assert.match(await page.locator('#page').textContent(),/Page 1 of 1/);assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
 // Narrow layout and keyboard focus are verified in the actual renderer.
 await page.setViewportSize({width:390,height:844});await search.focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'INPUT');assert.ok(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle!=='none'));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.keyboard.press('Space');await loaded();assert.equal(await page.getByLabel('Accounts',{exact:true}).isChecked(),true);assert.equal(await page.locator('#empty').isVisible(),true);await page.keyboard.press('Space');await loaded();assert.equal(await page.getByLabel('Accounts',{exact:true}).isChecked(),false);await page.locator('.table-wrap').focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(100);assert.ok(await page.locator('.table-wrap').evaluate(el=>el.scrollLeft>0));await page.locator('#rows button').first().focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('#detail-fields dd').length===11);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.getByRole('button',{name:'Back to results'}).click();await page.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('details').evaluate(el=>el.open),false);
 await page.screenshot({path:'.runtime/incident-explorer-mobile.png',fullPage:true});await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:'Clear filters'}).click();await loaded();await page.screenshot({path:'.runtime/incident-explorer-desktop.png',fullPage:true});
 assert.ok(observed.some(u=>u.startsWith('/api/export')));assert.ok(observed.some(u=>u.startsWith('/api/incidents/')));verificationPassed=true;
 }finally{for(const g of gates)g.release();if(browser)await browser.close();await close(server);assert.deepEqual(await readFile(datasetPath),bytes);await writeFile('.runtime/browser-verification.json',JSON.stringify({passed:verificationPassed,browser:browser?.version(),realLoopback:base,requests:observed.length,bootstrapChecks,browserClosed:true,httpServerClosed:!server.listening,canonicalBytesUnchanged:true,canonicalBytes:bytes.length,canonicalSha256:createHash('sha256').update(bytes).digest('hex')},null,2));}
});
